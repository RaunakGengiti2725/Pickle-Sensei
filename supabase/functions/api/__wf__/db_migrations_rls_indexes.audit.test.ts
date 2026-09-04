// Live-database audit matrix for the `db-migrations-rls-indexes` area.
//
// Boots a throwaway Docker postgres:16, installs the hosted-like shim from
// supabase/tests/shim_auth.sql, applies every migration in order (exactly like
// supabase/tests/run_rls_tests.sh) and then runs SQL probes as the
// `authenticated` role / as the table owner.
//
// Every case is an INVARIANT the migration chain promises. The three FIXED
// cases started life as reproductions of confirmed defects (client DELETE on
// shots resetting the free quota; unindexed cascade children; unindexed
// permit sweep) and were inverted when the 20260902* fix migrations landed.
// The static chain pins live in db_migrations_rls_indexes.test.ts.
//
// Run: deno test --allow-run --allow-read --allow-env supabase/functions/api/__wf__/
// Skips (does not fail) when Docker is unavailable.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl, join } from "jsr:@std/path@1";

const REPO_ROOT = fromFileUrl(new URL("../../../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const SHIM = join(REPO_ROOT, "supabase", "tests", "shim_auth.sql");
const CONTAINER = `wf-db-audit-${Date.now()}`;

const USER_A = "00000000-0000-4000-8000-00000000aaaa";

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

/** Runs SQL as the postgres superuser inside the container; returns stdout
 * with `-A -t` (unaligned, tuples only) so single-column probes are one value
 * per line. */
async function psql(sql: string, opts: { allowFail?: boolean } = {}) {
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
    ],
    { stdin: sql, allowFail: opts.allowFail },
  );
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
  await run(["docker", "cp", SHIM, `${CONTAINER}:/shim_auth.sql`]);
  await run(["docker", "cp", MIGRATIONS_DIR, `${CONTAINER}:/migrations`]);
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
    "-f",
    "/shim_auth.sql",
  ]);
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  }
  files.sort();
  for (const f of files) {
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
      "-f",
      `/migrations/${f}`,
    ]);
  }
}

async function teardown() {
  await run(["docker", "rm", "-f", CONTAINER], { allowFail: true });
}

const VERSION_VECTOR = `jsonb_build_object(
  'appVersion','1.0.0','modelBundleVersion','bundle-1','poseModelVersion','pose-1',
  'paddleModelVersion','paddle-1','strokeDetectorVersion','stroke-1',
  'phaseModelVersion','phase-1','scoringModelVersion','scoring-1','shotConfigVersion','config-1')`;

function scoredShotJson(id: string, permitKey: string) {
  return `jsonb_build_object(
    'id','${id}',
    'analysisPermitId',(select id from public.analysis_permits where idempotency_key='${permitKey}'),
    'sessionId',null,'shotType','dink','cameraView','side','capturedAt',now()::text,
    'startMs',0,'contactMs',100,'endMs',200,'overallScore',7.5,'confidence',0.9,'resultKind','scored',
    'phases','[]'::jsonb,'checkpoints','[]'::jsonb,'versionVector',${VERSION_VECTOR})`;
}

const asUser = (uid: string) => `
  set local role authenticated;
  select set_config('request.jwt.claim.sub', '${uid}', true);
  select set_config('request.jwt.claim.role', 'authenticated', true);
`;

const provision = (uid: string, email: string) => `
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('${uid}', '${email}', '{}'::jsonb, '{"provider":"google"}'::jsonb);
`;

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const skip = !(await dockerAvailable());

Deno.test({
  name: "db-migrations-rls-indexes audit matrix",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    await bootDatabase();
    try {
      await t.step(
        "INVARIANT: hosted-like matrix applies (migration chain + shim boot)",
        async () => {
          const r = await psql(`select count(*) from pg_policies where schemaname='public';`);
          assert(Number(lines(r.stdout)[0]) > 20, "RLS policies present");
        },
      );

      await t.step(
        "FIXED (high): authenticated has no DELETE on public.shots -> lifetime free-rating counter is not client-resettable",
        async () => {
          const consumeBothRatings = `
            ${provision(USER_A, "a@x.test")}
            ${asUser(USER_A)}
            select result from public.reserve_analysis_permit('k1');
            select public.apply_synced_shot(${scoredShotJson(
              "00000000-0000-4000-8000-0000000000e1",
              "k1",
            )});
            select result from public.reserve_analysis_permit('k2');
            select public.apply_synced_shot(${scoredShotJson(
              "00000000-0000-4000-8000-0000000000e2",
              "k2",
            )});
          `;
          const r = await psql(`
            begin;
            \\echo GRANTS
            select coalesce(string_agg(privilege_type, ',' order by privilege_type), '-')
              from information_schema.role_table_grants
             where grantee='authenticated' and table_schema='public' and table_name='shots';
            ${consumeBothRatings}
            \\echo BEFORE
            select scored_count from public.access_state();
            select result from public.reserve_analysis_permit('k3');
            \\echo END
            rollback;
          `);
          const out = lines(r.stdout);
          const grants = out[out.indexOf("GRANTS") + 1];
          // 20260902130000_shots_delete_revoke.sql revokes DELETE and drops shots_delete_own.
          assert(!grants.includes("DELETE"), `DELETE must be revoked, grants: ${grants}`);
          const before = out.slice(out.indexOf("BEFORE") + 1, out.indexOf("END"));
          assertEquals(before, ["2", "access.paywall_required"], "both lifetime ratings consumed");

          // The owner DELETE is rejected outright (42501) — ON_ERROR_STOP aborts
          // the script there, so the denial is probed in its own transaction.
          const del = await psql(
            `begin; ${consumeBothRatings}
            delete from public.shots where user_id = '${USER_A}'; rollback;`,
            { allowFail: true },
          );
          assert(del.code !== 0, "owner DELETE on shots must fail");
          assertStringIncludes(del.stderr, "permission denied for table shots");

          // And a DELETE that is refused cannot reopen the paywall: the
          // counter and the permit verdict are unchanged afterwards.
          const after = await psql(`
            begin;
            ${consumeBothRatings}
            savepoint before_delete;
            \\set ON_ERROR_STOP 0
            delete from public.shots where user_id = '${USER_A}';
            \\set ON_ERROR_STOP 1
            rollback to savepoint before_delete;
            \\echo AFTER
            select scored_count from public.access_state();
            select result from public.reserve_analysis_permit('k4');
            rollback;
          `);
          const afterOut = lines(after.stdout);
          assertEquals(
            afterOut.slice(afterOut.indexOf("AFTER") + 1),
            ["2", "access.paywall_required"],
            "counter must not reset",
          );
        },
      );

      await t.step(
        "INVARIANT: shots UPDATE, detail-row and ledger mutations stay denied",
        async () => {
          // ON_ERROR_STOP aborts at the first error, so each denial is its own transaction.
          const upd = await psql(
            `begin; ${provision(USER_A, "a@x.test")} ${asUser(USER_A)}
          update public.shots set overall_score = 9.9 where user_id = '${USER_A}'; rollback;`,
            { allowFail: true },
          );
          assertStringIncludes(upd.stderr, "permission denied for table shots");
          const delph = await psql(
            `begin; ${provision(USER_A, "a@x.test")} ${asUser(USER_A)}
          delete from public.shot_phases where user_id = '${USER_A}'; rollback;`,
            { allowFail: true },
          );
          assertStringIncludes(delph.stderr, "permission denied for table shot_phases");
          const delcons = await psql(
            `begin; ${provision(USER_A, "a@x.test")} ${asUser(USER_A)}
          delete from public.consent_records where user_id = '${USER_A}'; rollback;`,
            { allowFail: true },
          );
          assertStringIncludes(delcons.stderr, "permission denied for table consent_records");
        },
      );

      await t.step(
        "INVARIANT: access_state/reserve are SECURITY INVOKER; apply_synced_shot is the DEFINER writer (20260905000000); rank recompute is DEFINER, pinned, not client-executable",
        async () => {
          const r = await psql(`
          select p.proname || ':' || case when p.prosecdef then 'definer' else 'invoker' end || ':' ||
                 coalesce(array_to_string(p.proconfig, ';'), '-') || ':' ||
                 has_function_privilege('authenticated', p.oid, 'execute')::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('access_state','apply_synced_shot','reserve_analysis_permit','recompute_player_rank','handle_shot_rank_refresh','reject_ledger_mutation')
           order by 1;
        `);
          const rows = lines(r.stdout);
          const pinned = 'search_path=""';
          assert(rows.includes(`access_state:invoker:${pinned}:true`), rows.join("|"));
          assert(rows.includes(`apply_synced_shot:definer:${pinned}:true`), rows.join("|"));
          assert(rows.includes(`reserve_analysis_permit:invoker:${pinned}:true`), rows.join("|"));
          assert(rows.includes(`recompute_player_rank:definer:${pinned}:false`), rows.join("|"));
          assert(rows.includes(`handle_shot_rank_refresh:definer:${pinned}:false`), rows.join("|"));
          assert(rows.includes(`reject_ledger_mutation:invoker:${pinned}:false`), rows.join("|"));
        },
      );

      await t.step(
        "INVARIANT: hot reads use the owner indexes under RLS (100k-user shape)",
        async () => {
          // 5k users x 10 shots (rank trigger disabled for the bulk load only).
          await psql(`
          insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
          select ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 'u' || g || '@x.test', '{}'::jsonb, '{"provider":"google"}'::jsonb
          from generate_series(1, 5000) g;
          alter table public.shots disable trigger shots_player_rank_refresh;
          insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
            app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
          select gen_random_uuid(), p.id, (array['dink','drive','serve','volley'])[1 + (s % 4)], 'side', now() - (s || ' hours')::interval, 0, 100, 200,
            (random()*10)::numeric(4,2), 0.9, 'scored', '1.0.0','b','p','pa','s','ph','sc','c'
          from public.profiles p cross join generate_series(1, 10) s;
          alter table public.shots enable trigger shots_player_rank_refresh;
          insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
          select sh.id, sh.user_id, 'phase' || k, 0, 50, 100, 0.9 from public.shots sh cross join generate_series(1, 6) k;
          insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
          select p.id, 'k' || g, case when g % 50 = 0 then 'reserved' else 'finalized' end, case when g % 50 = 0 then null else 'scored' end, now() - (g || ' days')::interval
          from public.profiles p cross join generate_series(1, 15) g;
          insert into public.analysis_feedback (user_id, analysis_id, rating)
          select user_id, id, 'accurate' from public.shots where random() < 0.34;
          vacuum analyze public.shots; vacuum analyze public.shot_phases; vacuum analyze public.analysis_permits; vacuum analyze public.analysis_feedback;
        `);
          const uid = "00000000-0000-4000-9000-000000000123";
          const r = await psql(`
          begin;
          ${asUser(uid)}
          \\echo RANK
          explain (costs off) select shot_type, score from public.player_technique_rating where user_id = '${uid}' order by shot_type;
          \\echo PROGRESS
          explain (costs off) select day, shot_count from public.progress_daily where user_id = '${uid}' order by day;
          \\echo CONSENT
          explain (costs off) select scope from public.consent_records where user_id = '${uid}' order by created_at, id;
          \\echo PERMITS
          explain (costs off) select count(*) from public.analysis_permits where user_id = '${uid}' and status='reserved' and created_at > now() - interval '24 hours';
          rollback;
        `);
          const out = r.stdout;
          const section = (a: string, b?: string) =>
            out.slice(out.indexOf(a), b ? out.indexOf(b) : undefined);
          // Either owner-leading partial index is a correct choice for these two.
          assert(
            /shots_user_(type_)?scored_idx/.test(section("RANK", "PROGRESS")),
            section("RANK", "PROGRESS"),
          );
          assert(
            /shots_user_(type_)?scored_idx/.test(section("PROGRESS", "CONSENT")),
            section("PROGRESS", "CONSENT"),
          );
          assertStringIncludes(section("CONSENT", "PERMITS"), "consent_records_user_created_idx");
          // The reserved-only partial index (sweep index) holds just in-flight
          // permits, so it is an equally valid plan for the live-hold count.
          assert(
            /analysis_permits_(user_status|reserved_created)_idx/.test(section("PERMITS")),
            section("PERMITS"),
          );
          assert(!out.includes("Seq Scan"), `no sequential scans on hot reads:\n${out}`);
        },
      );

      await t.step(
        "FIXED (medium): profiles -> shot_phases / shot_measurements / analysis_feedback cascades are user_id-indexed (account deletion does not seq-scan them)",
        async () => {
          const uid = "00000000-0000-4000-9000-000000000123";
          const r = await psql(`
            \\echo PHASES
            explain (costs off) select 1 from public.shot_phases where user_id = '${uid}';
            \\echo MEASUREMENTS
            explain (costs off) select 1 from public.shot_measurements where user_id = '${uid}';
            \\echo FEEDBACK
            explain (costs off) select 1 from public.analysis_feedback where user_id = '${uid}';
            \\echo CASCADE
            begin;
            explain (analyze, costs off, timing off, summary off, buffers) delete from auth.users where id = '${uid}';
            rollback;
          `);
          const out = r.stdout;
          const section = (a: string, b: string) => out.slice(out.indexOf(a), out.indexOf(b));
          // 20260902130100_cascade_user_indexes.sql: user_id-leading indexes on
          // the three cascade children, so each probe is index-backed.
          const indexed = (plan: string, table: string) =>
            new RegExp(`(Index|Index Only|Bitmap Index) Scan .*${table}`).test(plan) &&
            !plan.includes(`Seq Scan on ${table}`);
          assert(indexed(section("PHASES", "MEASUREMENTS"), "shot_phases"), out);
          assert(indexed(section("MEASUREMENTS", "FEEDBACK"), "shot_measurements"), out);
          assert(indexed(section("FEEDBACK", "CASCADE"), "analysis_feedback"), out);
          assertStringIncludes(
            out,
            "Trigger for constraint shot_phases_user_id_fkey on profiles: calls=1",
          );
        },
      );

      await t.step(
        "FIXED (low): pg_cron stale-permit sweep predicate is index-backed (no hourly seq scan of every permit ever issued)",
        async () => {
          const r = await psql(`
            explain (costs off) update public.analysis_permits set status = 'released', outcome = 'expired'
              where status = 'reserved' and created_at < now() - interval '24 hours';
          `);
          // 20260902130200_permits_reserved_sweep_index.sql: partial (created_at)
          // index where status='reserved'.
          assert(!r.stdout.includes("Seq Scan on analysis_permits"), r.stdout);
          assert(/(Index|Bitmap Index) Scan .*analysis_permits/.test(r.stdout), r.stdout);
        },
      );
    } finally {
      await teardown();
    }
  },
});
