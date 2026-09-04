// Structural audit #2 (pass 1) — live probes for the `db-schema-migrations`
// subsystem written against 4d812e1aa699014cc0521fd92fde66908043aaa8.
//
// Same harness shape as db_migrations_rls_indexes.audit.test.ts: boots a
// throwaway Docker postgres:16, installs supabase/tests/shim_auth.sql, applies
// every migration in order, then probes as `authenticated` / as the owner.
//
// Every step asserts an INVARIANT the schema is documented to hold (migration
// comments, AGENTS.md, the mapper's invariant list). Steps prefixed
// `DEFECT (Px)` FAIL on 4d812e1a — that failure is the reproduction for the
// corresponding audit finding; when the fix migration lands the step turns
// green unchanged. Steps prefixed `INVARIANT` pass on 4d812e1a and pin
// behaviour no other harness exercises (concurrency of apply_synced_shot,
// backfill blocks against pre-existing data, cascade with missing rank row).
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json db_migrations_structural2.audit.test.ts
// Skips (does not fail) when Docker is unavailable.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl, join } from "jsr:@std/path@1";

const REPO_ROOT = fromFileUrl(new URL("../../../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const SHIM = join(REPO_ROOT, "supabase", "tests", "shim_auth.sql");
const CONTAINER = `wf-db-audit2-${Date.now()}`;

const ALICE = "00000000-0000-4000-8000-00000000aaaa";
const BOB = "00000000-0000-4000-8000-00000000bbbb";
const ALICE_2 = "00000000-0000-4000-8000-00000000aaa2";

async function run(cmd: string[], opts: { stdin?: string; allowFail?: boolean } = {}) {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }
  const out = await child.output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} failed (${out.code}):\n${stdout}\n${stderr}`);
  }
  return { code: out.code, stdout, stderr };
}

async function dockerAvailable(): Promise<boolean> {
  try {
    const r = await run(["docker", "info"], { allowFail: true });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** SQL as the postgres superuser inside the container (`-A -t`: one value per
 * line). `db` selects the database (the backfill step uses its own). */
async function psql(sql: string, opts: { allowFail?: boolean; db?: string } = {}) {
  return await run(
    [
      "docker",
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-A",
      "-t",
      "-U",
      "postgres",
      "-d",
      opts.db ?? "postgres",
    ],
    { stdin: sql, allowFail: opts.allowFail },
  );
}

async function migrationFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  }
  files.sort();
  return files;
}

async function applyFile(db: string, path: string) {
  await run([
    "docker",
    "exec",
    CONTAINER,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-U",
    "postgres",
    "-d",
    db,
    "-f",
    path,
  ]);
}

async function bootDatabase() {
  await run([
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-e",
    "POSTGRES_PASSWORD=pg",
    "postgres:16",
  ]);
  for (let i = 0; i < 60; i++) {
    const ready = await run(["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"], {
      allowFail: true,
    });
    if (ready.code === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // pg_isready can answer before the entrypoint's restart; make sure a real
  // session works before copying files in.
  for (let i = 0; i < 30; i++) {
    const ok = await psql("select 1;", { allowFail: true });
    if (ok.code === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await run(["docker", "cp", SHIM, `${CONTAINER}:/shim_auth.sql`]);
  await run(["docker", "cp", MIGRATIONS_DIR, `${CONTAINER}:/migrations`]);
  await applyFile("postgres", "/shim_auth.sql");
  for (const f of await migrationFiles()) {
    await applyFile("postgres", `/migrations/${f}`);
  }
}

async function teardown() {
  await run(["docker", "rm", "-f", CONTAINER], { allowFail: true });
}

const VERSION_VECTOR = `jsonb_build_object(
  'appVersion','1.0.0','modelBundleVersion','bundle-1','poseModelVersion','pose-1',
  'paddleModelVersion','paddle-1','strokeDetectorVersion','stroke-1',
  'phaseModelVersion','phase-1','scoringModelVersion','scoring-1','shotConfigVersion','config-1')`;

function scoredShotJson(id: string, permitKey: string, overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    id: `'${id}'`,
    analysisPermitId: `(select id from public.analysis_permits where idempotency_key='${permitKey}')`,
    sessionId: "null",
    shotType: "'dink'",
    cameraView: "'side'",
    capturedAt: "now()::text",
    startMs: "0",
    contactMs: "100",
    endMs: "200",
    overallScore: "7.5",
    confidence: "0.9",
    resultKind: "'scored'",
    phases: "'[]'::jsonb",
    checkpoints: "'[]'::jsonb",
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
  return `jsonb_build_object(${Object.entries(fields)
    .map(([k, v]) => `'${k}',${v}`)
    .join(",")})`;
}

/** Transaction-scoped impersonation. `set local` (not set_config) so the
 * script's stdout carries only probe values. */
const asUser = (uid: string) => `
  set local role authenticated;
  set local request.jwt.claim.sub = '${uid}';
  set local request.jwt.claim.role = 'authenticated';
`;

const switchUser = (uid: string) => `set local request.jwt.claim.sub = '${uid}';`;

const provision = (uid: string, email: string, provider = "google") => `
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('${uid}', '${email}', '{}'::jsonb, '{"provider":"${provider}"}'::jsonb);
`;

const identity = (uid: string, provider: string, subject: string) => `
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('${provider}', '${subject}', '${uid}', '{}'::jsonb);
`;

/** Direct (owner-trigger-driven) scored shots, bypassing the RPC — the shape
 * every backfill block and the rank trigger see. */
const directScoredShots = (
  uid: string,
  n: number,
  types = "array['dink','drive','serve','volley']",
) => `
  insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
    overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
    paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
  select gen_random_uuid(), '${uid}', (${types})[1 + (s % array_length(${types}, 1))], 'side',
         now() - (s || ' minutes')::interval, 0, 100, 200, (s % 10), 0.9, 'scored',
         '1','b','p','pa','s','ph','sc','c'
  from generate_series(1, ${n}) s;
`;

/** Every user the concurrency steps create is removed again (including the
 * identity ledger row, which by design survives the account). */
const cleanupUser = (uid: string, subject: string) => `
  delete from auth.users where id = '${uid}';
  delete from public.free_rating_ledger
   where identity_hash = public.free_rating_identity_hash('google', '${subject}');
`;

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const skip = !(await dockerAvailable());

Deno.test({
  name: "db-schema-migrations structural audit #2",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    await bootDatabase();
    try {
      await t.step("INVARIANT: migration chain + shim boot", async () => {
        const r = await psql(`select count(*) from pg_policies where schemaname='public';`);
        assert(Number(lines(r.stdout)[0]) > 20, "RLS policies present");
      });

      // ------------------------------------------------------------------
      // Cascades
      // ------------------------------------------------------------------
      await t.step(
        "INVARIANT: account deletion cascades even when scored shots exist without a player_rank_state row",
        async () => {
          const r = await psql(`
            begin;
            ${provision(ALICE, "a@x.test")}
            alter table public.shots disable trigger shots_player_rank_refresh;
            ${directScoredShots(ALICE, 3)}
            alter table public.shots enable trigger shots_player_rank_refresh;
            \\echo RANK_ROWS
            select count(*) from public.player_rank_state where user_id = '${ALICE}';
            delete from auth.users where id = '${ALICE}';
            \\echo LEFT
            select count(*) from public.shots where user_id = '${ALICE}';
            select count(*) from public.player_rank_state where user_id = '${ALICE}';
            rollback;
          `);
          const out = lines(r.stdout);
          assertEquals(out[out.indexOf("RANK_ROWS") + 1], "0", "precondition: no rank row");
          assertEquals(out.slice(out.indexOf("LEFT") + 1), ["0", "0"], "cascade completed");
        },
      );

      await t.step(
        "INVARIANT: heavy account (400 scored shots) cascade-deletes; per-row rank trigger fires N times but leaves no rank row",
        async () => {
          const r = await psql(`
            begin;
            ${provision(ALICE, "a@x.test")}
            ${directScoredShots(ALICE, 400)}
            explain (analyze, costs off, timing off, summary off)
              delete from auth.users where id = '${ALICE}';
            \\echo LEFT
            select count(*) from public.player_rank_state where user_id = '${ALICE}';
            rollback;
          `);
          const out = lines(r.stdout);
          const triggerLine = out.find((l) => l.startsWith("Trigger shots_player_rank_refresh"));
          assert(triggerLine, `rank trigger appears in the plan: ${out.join(" | ")}`);
          assertStringIncludes(triggerLine!, "calls=400", "one recompute per cascaded shot row");
          assertEquals(out[out.length - 1], "0", "rank row removed with the evidence");
        },
      );

      // ------------------------------------------------------------------
      // apply_synced_shot / reserve_analysis_permit concurrency
      // ------------------------------------------------------------------
      const seedConcurrent = async (uid: string, subject: string, keys: string[]) => {
        await psql(`
          ${cleanupUser(uid, subject)}
          ${provision(uid, `${subject}@x.test`)}
          ${identity(uid, "google", subject)}
        `);
        for (const k of keys) {
          await psql(`
            begin;
            ${asUser(uid)}
            select result from public.reserve_analysis_permit('${k}');
            commit;
          `);
        }
      };

      /** Session A runs `sqlA` and holds its transaction open for 2s; session
       * B starts 700ms later so it queues behind A's locks. */
      const race = async (uid: string, sqlA: string, sqlB: string) => {
        const a = psql(`
          begin;
          ${asUser(uid)}
          ${sqlA}
          select pg_sleep(2);
          commit;
        `);
        await sleep(700);
        const b = psql(`
          begin;
          ${asUser(uid)}
          ${sqlB}
          commit;
        `);
        const [ra, rb] = await Promise.all([a, b]);
        return { a: lines(ra.stdout), b: lines(rb.stdout) };
      };

      await t.step(
        "DEFECT (P3): a concurrent retry of the SAME shot sync must replay-accept, not be rejected as access.permit_not_reserved",
        async () => {
          await seedConcurrent(ALICE, "g-c1", ["k1"]);
          const shot = "00000000-0000-4000-8000-00000000ee01";
          const { a, b } = await race(
            ALICE,
            `select 'A:' || public.apply_synced_shot(${scoredShotJson(shot, "k1")});`,
            `select 'B:' || public.apply_synced_shot(${scoredShotJson(shot, "k1")});`,
          );
          const state = lines(
            (
              await psql(`
              select count(*) from public.shots where user_id = '${ALICE}';
              select status || '/' || outcome from public.analysis_permits where user_id = '${ALICE}';
            `)
            ).stdout,
          );
          assertEquals(state, ["1", "finalized/scored"], "exactly one shot, permit finalized once");
          assertEquals(
            a.find((l) => l.startsWith("A:")),
            "A:accepted",
          );
          // 20260902150000_free_rating_identity_ledger.sql:400 — "Lock the permit
          // so a concurrent retry of the same sync serializes here" — and the
          // unique_violation handler promise "ours → replay-accept". The retry
          // serializes, then hits the status check first and is refused. The
          // edge's batched replay lookup (index.ts syncShots) heals this on the
          // NEXT drain, but the mobile outbox counts the verdict as permanent.
          assertEquals(
            b.find((l) => l.startsWith("B:")),
            "B:accepted",
            "the serialized retry of an already-committed shot must be an idempotent replay",
          );
        },
      );

      await t.step(
        "INVARIANT: reserve_analysis_permit racing a sync that reaches scored=2 is refused (shared advisory lock)",
        async () => {
          await seedConcurrent(ALICE, "g-c2", ["k1", "k2"]);
          await psql(`
            begin; ${asUser(ALICE)}
            select public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee11", "k1")});
            commit;
          `);
          const { a, b } = await race(
            ALICE,
            `select 'A:' || public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee12", "k2")});`,
            `select 'B:' || result from public.reserve_analysis_permit('k3');`,
          );
          assertEquals(
            a.find((l) => l.startsWith("A:")),
            "A:accepted",
          );
          assertEquals(
            b.find((l) => l.startsWith("B:")),
            "B:access.paywall_required",
          );
          const scored = lines(
            (
              await psql(
                `select count(*) from public.shots where user_id='${ALICE}' and result_kind='scored';`,
              )
            ).stdout,
          );
          assertEquals(scored, ["2"]);
        },
      );

      await t.step(
        "INVARIANT: two concurrent scored syncs with DIFFERENT reserved permits at scored=1 record exactly one more (backstop under lock)",
        async () => {
          await seedConcurrent(ALICE, "g-c3", ["k1", "k2"]);
          await psql(`
            begin; ${asUser(ALICE)}
            select public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee21", "k1")});
            -- owner reopens the finalized permit (status column is client-writable)
            update public.analysis_permits set status='reserved', outcome=null where idempotency_key='k1';
            commit;
          `);
          const { a, b } = await race(
            ALICE,
            `select 'A:' || public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee22", "k1")});`,
            `select 'B:' || public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee23", "k2")});`,
          );
          assertEquals(
            a.find((l) => l.startsWith("A:")),
            "A:accepted",
          );
          assertEquals(
            b.find((l) => l.startsWith("B:")),
            "B:access.paywall_required",
          );
          const state = lines(
            (
              await psql(`
              select count(*) from public.shots where user_id='${ALICE}' and result_kind='scored';
              select string_agg(idempotency_key || '=' || status || '/' || coalesce(outcome,'-'), ',' order by idempotency_key)
                from public.analysis_permits where user_id='${ALICE}';
              select scored_count from public.free_rating_ledger
               where identity_hash = public.free_rating_identity_hash('google','g-c3');
            `)
            ).stdout,
          );
          assertEquals(state, ["2", "k1=finalized/scored,k2=released/free_limit_exceeded", "2"]);
        },
      );

      await t.step(
        "INVARIANT: 24 concurrent scored syncs on 24 over-issued reserved permits record exactly 2 scored shots",
        async () => {
          await seedConcurrent(ALICE, "g-c5", ["k1", "k2"]);
          await psql(
            `insert into public.analysis_permits (user_id, idempotency_key)
               select '${ALICE}', 'x' || g from generate_series(1, 22) g;`,
          );
          const results = await Promise.all(
            Array.from({ length: 24 }, (_, i) => {
              const key = i < 2 ? `k${i + 1}` : `x${i - 1}`;
              const id = `00000000-0000-4000-8000-0000000${(i + 1).toString(16).padStart(5, "0")}`;
              return psql(`
                begin; ${asUser(ALICE)}
                select public.apply_synced_shot(${scoredShotJson(id, key)});
                commit;
              `);
            }),
          );
          const outcomes = results.map((r) => lines(r.stdout).at(-1));
          assertEquals(outcomes.filter((o) => o === "accepted").length, 2, outcomes.join(","));
          assertEquals(
            outcomes.filter((o) => o === "access.paywall_required").length,
            22,
            outcomes.join(","),
          );
          const state = lines(
            (
              await psql(`
              select count(*) from public.shots where user_id='${ALICE}' and result_kind='scored';
              select count(*) from public.analysis_permits where user_id='${ALICE}' and status='finalized';
              select count(*) from public.analysis_permits where user_id='${ALICE}' and status='released' and outcome='free_limit_exceeded';
            `)
            ).stdout,
          );
          assertEquals(state, ["2", "2", "22"]);
        },
      );

      await t.step(
        "INVARIANT: 24 concurrent reserves with distinct keys mint exactly 2 permits",
        async () => {
          await seedConcurrent(ALICE, "g-c4", []);
          const results = await Promise.all(
            Array.from({ length: 24 }, (_, i) =>
              psql(`
              begin; ${asUser(ALICE)}
              select result from public.reserve_analysis_permit('key-${i}');
              commit;
            `),
            ),
          );
          const outcomes = results.map((r) => lines(r.stdout).at(-1));
          assertEquals(outcomes.filter((o) => o === "accepted").length, 2, outcomes.join(","));
          const n = lines(
            (await psql(`select count(*) from public.analysis_permits where user_id='${ALICE}';`))
              .stdout,
          );
          assertEquals(n, ["2"]);
          await psql(cleanupUser(ALICE, "g-c4"));
        },
      );

      // ------------------------------------------------------------------
      // Identity ledger
      // ------------------------------------------------------------------
      await t.step(
        "DEFECT (P2): an identity linked AFTER the free ratings were spent must carry the count across account deletion",
        async () => {
          const r = await psql(`
            begin;
            ${provision(ALICE, "a@x.test")}
            ${identity(ALICE, "google", "g-late")}
            ${asUser(ALICE)}
            select result from public.reserve_analysis_permit('k1');
            select result from public.reserve_analysis_permit('k2');
            select public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee31", "k1")});
            select public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee32", "k2")});
            reset role;
            -- Same account links Sign in with Apple afterwards (Supabase auto-links
            -- same-verified-email identities into one user).
            ${identity(ALICE, "apple", "ap-late")}
            \\echo LEDGER
            select coalesce(max(scored_count), 0) from public.free_rating_ledger
             where identity_hash = public.free_rating_identity_hash('google', 'g-late');
            select coalesce(max(scored_count), 0) from public.free_rating_ledger
             where identity_hash = public.free_rating_identity_hash('apple', 'ap-late');
            -- delete the account; sign in again with ONLY the Apple identity
            delete from auth.users where id = '${ALICE}';
            ${provision(ALICE_2, "a@x.test", "apple")}
            ${identity(ALICE_2, "apple", "ap-late")}
            ${asUser(ALICE_2)}
            \\echo RECREATED
            select scored_count from public.access_state();
            select result from public.reserve_analysis_permit('k3');
            rollback;
          `);
          const out = lines(r.stdout);
          const ledger = out.slice(out.indexOf("LEDGER") + 1, out.indexOf("RECREATED"));
          // 20260902150000_free_rating_identity_ledger.sql:158-177 writes the
          // ledger only on scored insert; the backfill block runs once at
          // migration time. A later-linked identity never receives a row.
          assertEquals(
            { ledger, recreated: out.slice(out.indexOf("RECREATED") + 1) },
            { ledger: ["2", "2"], recreated: ["2", "access.paywall_required"] },
            "every linked identity carries the identity-max count; re-signin via the late identity must still see both ratings spent",
          );
        },
      );

      await t.step(
        "INVARIANT: ledger keeps counting for premium accounts; a lapsed entitlement is refused at the lifetime limit",
        async () => {
          const r = await psql(`
            begin;
            ${provision(ALICE, "a@x.test")}
            ${identity(ALICE, "google", "g-prem")}
            insert into public.billing_entitlements (user_id, premium, expires_at) values ('${ALICE}', true, null);
            ${directScoredShots(ALICE, 5)}
            select scored_count from public.free_rating_ledger
             where identity_hash = public.free_rating_identity_hash('google','g-prem');
            delete from public.billing_entitlements where user_id = '${ALICE}';
            ${asUser(ALICE)}
            select premium::text || '/' || scored_count from public.access_state();
            select result from public.reserve_analysis_permit('k1');
            rollback;
          `);
          assertEquals(lines(r.stdout), ["5", "false/5", "access.paywall_required"]);
        },
      );

      // ------------------------------------------------------------------
      // Permit lifecycle
      // ------------------------------------------------------------------
      await t.step(
        "DEFECT (P3): owner must not be able to reopen a finalized permit (finalized -> reserved) and reuse it for another scored sync",
        async () => {
          const r = await psql(`
            begin;
            ${provision(ALICE, "a@x.test")}
            ${asUser(ALICE)}
            select result from public.reserve_analysis_permit('k1');
            select public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee41", "k1")});
            select status || '/' || outcome from public.analysis_permits where idempotency_key='k1';
            update public.analysis_permits set status='reserved', outcome=null where idempotency_key='k1';
            select status || '/' || coalesce(outcome,'-') from public.analysis_permits where idempotency_key='k1';
            select public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee42", "k1")});
            select count(*) from public.shots where user_id='${ALICE}';
            select count(*) from public.analysis_permits where user_id='${ALICE}';
            rollback;
          `);
          const out = lines(r.stdout);
          assertEquals(out[0], "accepted");
          assertEquals(out[1], "accepted");
          assertEquals(out[2], "finalized/scored");
          // 20260831160000_defense_in_depth.sql:66 grants UPDATE(status, outcome);
          // the only guard is the enum CHECK in 20260829140000_permits_sync_consent.sql.
          assertEquals(out[3], "finalized/scored", "finalized permit must stay finalized");
          assertEquals(
            out[4],
            "access.permit_not_reserved",
            "a spent permit must not admit a second shot",
          );
          assertEquals(out.slice(5), ["1", "1"], "one shot per permit");
        },
      );

      await t.step(
        "INVARIANT: expired reserved permit is not counted, same-key retry still returns it, sync releases it as expired",
        async () => {
          const r = await psql(`
            begin;
            ${provision(ALICE, "a@x.test")}
            ${asUser(ALICE)}
            select result from public.reserve_analysis_permit('k1');
            reset role;
            update public.analysis_permits set created_at = now() - interval '25 hours' where idempotency_key='k1';
            ${asUser(ALICE)}
            select reserved_count from public.access_state();
            select result || '/' || permit_status from public.reserve_analysis_permit('k1');
            select public.apply_synced_shot(${scoredShotJson("00000000-0000-4000-8000-00000000ee51", "k1")});
            select status || '/' || outcome from public.analysis_permits where idempotency_key='k1';
            rollback;
          `);
          assertEquals(lines(r.stdout), [
            "accepted",
            "0",
            "accepted/reserved",
            "access.permit_expired",
            "released/expired",
          ]);
        },
      );

      await t.step(
        "INVARIANT: a failing shot write returns shot.write_failed and leaves the permit reserved (retryable)",
        async () => {
          const r = await psql(`
            begin;
            ${provision(ALICE, "a@x.test")}
            ${asUser(ALICE)}
            select result from public.reserve_analysis_permit('k1');
            select public.apply_synced_shot(${scoredShotJson(
              "00000000-0000-4000-8000-00000000ee61",
              "k1",
              {
                cameraView: "'upside_down'",
              },
            )});
            select status from public.analysis_permits where idempotency_key='k1';
            select count(*) from public.shots where user_id='${ALICE}';
            rollback;
          `);
          const out = lines(r.stdout);
          assertEquals(out[0], "accepted");
          assertStringIncludes(out[1], "shot.write_failed:");
          assertEquals(out.slice(2), ["reserved", "0"]);
        },
      );

      // ------------------------------------------------------------------
      // RPC input handling
      // ------------------------------------------------------------------
      await t.step(
        "DEFECT (P3): RPCs must return a status code, not raise, on malformed ids / null / oversized idempotency keys",
        async () => {
          const setup = `${provision(ALICE, "a@x.test")} ${asUser(ALICE)}`;
          const cases: Array<[string, string]> = [
            [
              "malformed shot id",
              `select public.apply_synced_shot('{"id":"nope","analysisPermitId":"x"}'::jsonb);`,
            ],
            ["null idempotency key", `select result from public.reserve_analysis_permit(null);`],
            [
              "oversized idempotency key",
              `select result from public.reserve_analysis_permit(repeat('x', 10000));`,
            ],
          ];
          const raised: string[] = [];
          for (const [name, sql] of cases) {
            const r = await psql(`begin; ${setup} ${sql} rollback;`, { allowFail: true });
            if (r.code !== 0) raised.push(`${name}: ${lines(r.stderr)[0]}`);
          }
          // 20260902150000_free_rating_identity_ledger.sql:384-386 casts before
          // the exception block; reserve_analysis_permit's handler catches only
          // unique_violation. Edge validation (index.ts parseSyncShot /
          // reserveAnalysisPermit) is the only thing keeping these out.
          assertEquals(raised, [], "every malformed input maps to a status");
        },
      );

      await t.step(
        "INVARIANT: empty payload maps to access.permit_not_found; empty key is accepted (edge rejects it first)",
        async () => {
          const r = await psql(`
          begin;
          ${provision(ALICE, "a@x.test")}
          ${asUser(ALICE)}
          select public.apply_synced_shot('{}'::jsonb);
          select result || '/' || (permit_id is not null)::text from public.reserve_analysis_permit('');
          rollback;
        `);
          assertEquals(lines(r.stdout), ["access.permit_not_found", "accepted/true"]);
        },
      );

      // ------------------------------------------------------------------
      // Constraints
      // ------------------------------------------------------------------
      await t.step(
        "DEFECT (P3): temporal sanity — sessions.ended_at >= started_at, start_ms <= contact_ms <= end_ms, captured_at not in the far future",
        async () => {
          const accepted: string[] = [];
          const s1 = await psql(
            `
            begin; ${provision(ALICE, "a@x.test")} ${asUser(ALICE)}
            insert into public.sessions (id, user_id, started_at, ended_at)
            values ('00000000-0000-4000-8000-00000000dd01', '${ALICE}', now(), now() - interval '1 day');
            rollback;`,
            { allowFail: true },
          );
          if (s1.code === 0) accepted.push("sessions.ended_at < started_at");
          const s2 = await psql(
            `
            begin; ${provision(ALICE, "a@x.test")} ${asUser(ALICE)}
            select result from public.reserve_analysis_permit('k1');
            select public.apply_synced_shot(${scoredShotJson(
              "00000000-0000-4000-8000-00000000ee71",
              "k1",
              {
                startMs: "500",
                contactMs: "100",
                endMs: "0",
                capturedAt: "'2999-01-01T00:00:00Z'",
              },
            )});
            select day::text from public.progress_daily where user_id = '${ALICE}';
            rollback;`,
            { allowFail: true },
          );
          const out = lines(s2.stdout);
          if (out[1] === "accepted") accepted.push("start_ms > contact_ms > end_ms");
          if (out[2] === "2999-01-01") accepted.push("captured_at=2999 reaches progress_daily");
          // 20260829120000_progress_data.sql defines no CHECK on any of these.
          assertEquals(accepted, [], "temporal garbage must be rejected at the schema");
        },
      );

      // ------------------------------------------------------------------
      // Grants / RLS interplay
      // ------------------------------------------------------------------
      await t.step(
        "DEFECT (P3): authenticated must not hold TRUNCATE/TRIGGER/REFERENCES on client tables (hosted default privileges)",
        async () => {
          const r = await psql(`
            select table_name || ':' || string_agg(privilege_type, ',' order by privilege_type)
              from information_schema.role_table_grants
             where grantee = 'authenticated' and table_schema = 'public'
               and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
             group by table_name order by table_name;
          `);
          const dangerous = lines(r.stdout);
          const truncate = await psql(
            `begin; ${asUser(ALICE)} truncate public.shots cascade; select 'TRUNCATED'; rollback;`,
            { allowFail: true },
          );
          const billing = await psql(
            `begin; ${asUser(ALICE)} truncate public.billing_entitlements; select 'TRUNCATED'; rollback;`,
            { allowFail: true },
          );
          // shim_auth.sql:61-64 mirrors hosted `alter default privileges ... grant
          // all on tables`; no migration revokes these three. Unreachable through
          // PostgREST, but a SQL-level `authenticated` session can empty shots
          // (and its cascade children) and billing_entitlements.
          assertEquals(dangerous, [], `dangerous privileges present: ${dangerous.join(" ")}`);
          assert(truncate.code !== 0, "truncate public.shots cascade must be denied");
          assert(billing.code !== 0, "truncate public.billing_entitlements must be denied");
        },
      );

      await t.step(
        "INVARIANT: aggregate views reject writes even though INSERT/UPDATE/DELETE are granted",
        async () => {
          for (const v of ["progress_daily", "practice_days", "player_technique_rating"]) {
            const r = await psql(`begin; ${asUser(ALICE)} delete from public.${v}; rollback;`, {
              allowFail: true,
            });
            assert(r.code !== 0, `${v} must not be deletable`);
            assertStringIncludes(r.stderr, "not automatically updatable");
          }
        },
      );

      await t.step(
        "DEFECT (P3): FK checks bypass RLS — a client can attach detail rows to another user's shot / session",
        async () => {
          const r = await psql(
            `
            begin;
            ${provision(ALICE, "a@x.test")}
            ${provision(BOB, "b@x.test")}
            ${asUser(BOB)}
            insert into public.sessions (id, user_id, started_at) values ('00000000-0000-4000-8000-00000000dd11', '${BOB}', now());
            insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
              overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
              paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
            values ('00000000-0000-4000-8000-00000000ee80', '${BOB}', 'dink', 'side', now(), 0, 100, 200,
              7, 0.9, 'scored', '1','b','p','pa','s','ph','sc','c');
            ${switchUser(ALICE)}
            \\echo ALICE
            insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
              overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
              paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
            values ('00000000-0000-4000-8000-00000000ee81', '${ALICE}', '00000000-0000-4000-8000-00000000dd11', 'dink', 'side', now(), 0, 100, 200,
              7, 0.9, 'scored', '1','b','p','pa','s','ph','sc','c');
            select 'shot_on_bobs_session';
            insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
            values ('00000000-0000-4000-8000-00000000ee80', '${ALICE}', 'prepare', 0, 1, 2, 0.5);
            select 'phase_on_bobs_shot';
            rollback;`,
            { allowFail: true },
          );
          const out = lines(r.stdout);
          const crossed = out.slice(out.indexOf("ALICE") + 1);
          // shots.session_id -> sessions(id) and shot_phases.shot_id -> shots(id)
          // are single-column FKs; RI checks run as the table owner, so RLS on
          // the parent does not apply. Composite (id, user_id) FKs would close it.
          assertEquals(crossed, [], `cross-user references accepted: ${crossed.join(",")}`);
        },
      );

      await t.step(
        "INVARIANT: session id collision across users leaks nothing and never transfers ownership",
        async () => {
          const r = await psql(`
          begin;
          ${provision(ALICE, "a@x.test")}
          ${provision(BOB, "b@x.test")}
          ${asUser(BOB)}
          insert into public.sessions (id, user_id, started_at) values ('00000000-0000-4000-8000-00000000dd21', '${BOB}', now());
          ${switchUser(ALICE)}
          insert into public.sessions (id, user_id, started_at) values ('00000000-0000-4000-8000-00000000dd21', '${ALICE}', now())
            on conflict (id) do nothing;
          select count(*) from public.sessions where id = '00000000-0000-4000-8000-00000000dd21';
          reset role;
          select (user_id = '${BOB}')::text from public.sessions where id = '00000000-0000-4000-8000-00000000dd21';
          rollback;
        `);
          assertEquals(lines(r.stdout), ["0", "true"]);
        },
      );

      await t.step(
        "INVARIANT: signup with null metadata provisions a profile (provider 'unknown')",
        async () => {
          const r = await psql(`
          begin;
          insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ('${ALICE}', null, null, null);
          select provider || '/' || coalesce(email, 'null') from public.profiles where id = '${ALICE}';
          rollback;
        `);
          assertEquals(lines(r.stdout), ["unknown/null"]);
        },
      );

      // ------------------------------------------------------------------
      // Function security posture
      // ------------------------------------------------------------------
      await t.step(
        "DEFECT (P3): every client-executable function in public pins search_path",
        async () => {
          const r = await psql(`
            select p.proname
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
               and coalesce(array_to_string(p.proconfig, ';'), '') not like '%search_path=%'
             order by 1;
          `);
          // 20260829000000_google_auth_bootstrap.sql complete_onboarding() (client
          // RPC) and 20260829150000_player_rank.sql player_rank_tier() (PUBLIC
          // execute by default) have no `set search_path`.
          assertEquals(lines(r.stdout), [], "unpinned client-executable functions");
        },
      );

      await t.step(
        "INVARIANT: hot RPCs are SECURITY INVOKER + pinned; definer helpers are not client-executable",
        async () => {
          const r = await psql(`
          select p.proname || ':' || p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ';'), '-')
                 || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('access_state','apply_synced_shot','reserve_analysis_permit','lifetime_scored_count',
                               'identity_scored_count','recompute_player_rank','record_scored_shot_in_ledger','handle_new_user');
        `);
          assertEquals(
            lines(r.stdout).sort(),
            [
              'access_state:false:search_path="":true',
              'apply_synced_shot:false:search_path="":true',
              'handle_new_user:true:search_path="":false',
              'identity_scored_count:true:search_path="":true',
              'lifetime_scored_count:false:search_path="":true',
              'recompute_player_rank:true:search_path="":false',
              'record_scored_shot_in_ledger:true:search_path="":false',
              'reserve_analysis_permit:false:search_path="":true',
            ].sort(),
          );
        },
      );

      // ------------------------------------------------------------------
      // pg_cron
      // ------------------------------------------------------------------
      await t.step(
        "INVARIANT: the three pg_cron sweep statements are valid SQL against the final schema",
        async () => {
          const r = await psql(`
          begin;
          update public.analysis_permits set status = 'released', outcome = 'expired'
           where status = 'reserved' and created_at < now() - interval '24 hours';
          delete from public.account_deletion_requests where expires_at < now() - interval '1 day';
          delete from public.webhook_events where received_at < now() - interval '90 days';
          select 'ok';
          select count(*) from pg_available_extensions where name = 'pg_cron';
          rollback;
        `);
          const out = lines(r.stdout);
          assertEquals(out[0], "ok");
          // postgres:16 ships no pg_cron: the schedules are never installed in
          // any harness (the migration swallows that with a NOTICE). Hosted
          // schedule state is UNKNOWN from here.
          console.log(`pg_cron available in harness image: ${out[1] !== "0"}`);
        },
      );

      // ------------------------------------------------------------------
      // Backfill blocks against PRE-EXISTING data (fresh database)
      // ------------------------------------------------------------------
      await t.step(
        "INVARIANT: form_weighted_rank recompute-all and identity-ledger backfill are correct against pre-existing rows",
        async () => {
          await psql(`drop database if exists backfill; create database backfill;`);
          await applyFile("backfill", "/shim_auth.sql");
          const F1 = "00000000-0000-4000-8000-0000000000f1";
          const F2 = "00000000-0000-4000-8000-0000000000f2";
          const F3 = "00000000-0000-4000-8000-0000000000f3";
          const F4 = "00000000-0000-4000-8000-0000000000f4";
          const F5 = "00000000-0000-4000-8000-0000000000f5";
          let preRank = "";
          let postRank: string[] = [];
          for (const f of await migrationFiles()) {
            if (f === "20260831130000_form_weighted_rank.sql") {
              const r = await psql(
                `
                ${provision(F1, "f1@x.test")}
                ${provision(F2, "f2@x.test")}
                ${directScoredShots(F1, 12, "array['dink','drive']")}
                alter table public.player_rank_state disable trigger all;
                insert into public.player_rank_state (user_id, rating, tier, technique_count, scored_shot_count)
                values ('${F2}', 5, 'silver', 1, 1);
                alter table public.player_rank_state enable trigger all;
                select rating || '/' || tier || '/' || scored_shot_count from public.player_rank_state where user_id = '${F1}';
              `,
                { db: "backfill" },
              );
              preRank = lines(r.stdout)[0];
            }
            if (f === "20260902150000_free_rating_identity_ledger.sql") {
              await psql(
                `
                ${provision(F3, "f3@x.test")}
                ${provision(F4, "f4@x.test", "apple")}
                ${identity(F1, "google", "g-f1")}
                ${identity(F1, "apple", "ap-f1")}
                ${identity(F3, "google", "g-f3")}
                ${identity(F4, "apple", "ap-f4")}
                ${directScoredShots(F3, 1)}
                insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
                  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
                  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
                values (gen_random_uuid(), '${F3}', 'dink', 'side', now(), 0, 100, 200, null, 0.2, 'low_confidence',
                  '1','b','p','pa','s','ph','sc','c');
              `,
                { db: "backfill" },
              );
            }
            await applyFile("backfill", `/migrations/${f}`);
            if (f === "20260831130000_form_weighted_rank.sql") {
              const r = await psql(
                `
                select rating || '/' || tier || '/' || scored_shot_count || '/' || technique_count from public.player_rank_state where user_id = '${F1}';
                select count(*) from public.player_rank_state where user_id = '${F2}';
              `,
                { db: "backfill" },
              );
              postRank = lines(r.stdout);
            }
          }
          assert(preRank.length > 0, "v1 rank row existed before the v2 migration");
          assertEquals(
            postRank[1],
            "0",
            "stale rank row without evidence is removed by the recompute-all block",
          );
          assert(
            /\/12\/2$/.test(postRank[0]),
            `v2 rank row rebuilt from all 12 shots, 2 techniques: ${postRank[0]}`,
          );

          const r = await psql(
            `
            select count(*) from public.free_rating_ledger;
            select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','g-f1');
            select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple','ap-f1');
            select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','g-f3');
            select count(*) from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple','ap-f4');
            begin; ${asUser(F3)}
            select public.lifetime_scored_count();
            commit;
            begin; ${asUser(F1)}
            select result from public.reserve_analysis_permit('bk1');
            commit;
            delete from auth.users where id = '${F3}';
            ${provision(F5, "f3@x.test")}
            ${identity(F5, "google", "g-f3")}
            begin; ${asUser(F5)}
            select public.lifetime_scored_count();
            commit;
          `,
            { db: "backfill" },
          );
          assertEquals(lines(r.stdout), [
            "3",
            "12",
            "12",
            "1",
            "0",
            "1",
            "access.paywall_required",
            "1",
          ]);
        },
      );
    } finally {
      await teardown();
    }
  },
});
