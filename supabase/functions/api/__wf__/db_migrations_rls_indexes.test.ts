// Static pins over the migration chain in supabase/migrations. The live
// behaviour (grant layer, quota, planner) is asserted by
// supabase/tests/security_regression.sql cases H7 and I1–I3 against a real
// Postgres; this suite guards the chain itself so a later migration cannot
// quietly reopen a closed path or drop a load-bearing index.
//
//   deno test --no-config --allow-read supabase/functions/api/__wf__/

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MIGRATIONS_DIR = new URL("../../../migrations/", import.meta.url);

const SHOTS_DELETE_REVOKE = "20260902000000_shots_delete_revoke.sql";
const CASCADE_USER_INDEXES = "20260902000100_cascade_user_indexes.sql";
const PERMITS_SWEEP_INDEX = "20260902000200_permits_reserved_sweep_index.sql";
const SCALE_AND_SECURITY = "20260831000000_scale_and_security.sql";

const REQUIRED_INDEXES: ReadonlyArray<{
  name: string;
  table: string;
  definition: RegExp;
  migration: string;
}> = [
  {
    name: "shot_phases_user_idx",
    table: "shot_phases",
    definition: /on public\.shot_phases \(user_id\)/,
    migration: CASCADE_USER_INDEXES,
  },
  {
    name: "shot_measurements_user_idx",
    table: "shot_measurements",
    definition: /on public\.shot_measurements \(user_id\)/,
    migration: CASCADE_USER_INDEXES,
  },
  {
    name: "analysis_feedback_user_created_idx",
    table: "analysis_feedback",
    definition: /on public\.analysis_feedback \(user_id, created_at desc\)/,
    migration: CASCADE_USER_INDEXES,
  },
  {
    name: "analysis_permits_reserved_created_idx",
    table: "analysis_permits",
    definition: /on public\.analysis_permits \(created_at\) where status = 'reserved'/,
    migration: PERMITS_SWEEP_INDEX,
  },
];

type Migration = { file: string; statements: string[] };

function normalizeSql(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((statement) => statement.length > 0);
}

async function loadChain(): Promise<Migration[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  }
  files.sort();
  const chain: Migration[] = [];
  for (const file of files) {
    const sql = await Deno.readTextFile(new URL(file, MIGRATIONS_DIR));
    chain.push({ file, statements: normalizeSql(sql) });
  }
  return chain;
}

function after(chain: Migration[], file: string): Migration[] {
  const index = chain.findIndex((m) => m.file === file);
  ok(index >= 0, `${file} must exist in the migration chain`);
  return chain.slice(index + 1);
}

function statementsOf(chain: Migration[], file: string): string[] {
  const migration = chain.find((m) => m.file === file);
  ok(migration, `${file} must exist in the migration chain`);
  return migration.statements;
}

function grantsDeleteOnShots(statement: string): boolean {
  if (!statement.startsWith("grant ")) return false;
  const [privileges, objects = ""] = statement.split(" on ", 2);
  if (!/\bdelete\b/.test(privileges) && !/\ball\b/.test(privileges)) {
    return false;
  }
  return /\bpublic\.shots\b/.test(objects);
}

function createsDeletePolicyOnShots(statement: string): boolean {
  return (
    statement.startsWith("create policy") &&
    /\bon public\.shots\b/.test(statement) &&
    /\bfor delete\b/.test(statement)
  );
}

Deno.test("shots: the client DELETE path is closed and never reopened", async () => {
  const chain = await loadChain();
  const revoke = statementsOf(chain, SHOTS_DELETE_REVOKE);
  ok(
    revoke.includes("revoke delete on public.shots from authenticated"),
    "the revoke migration must drop the authenticated DELETE grant on shots",
  );
  ok(
    revoke.includes('drop policy if exists "shots_delete_own" on public.shots'),
    "the revoke migration must drop the shots_delete_own policy",
  );

  for (const migration of after(chain, SHOTS_DELETE_REVOKE)) {
    for (const statement of migration.statements) {
      ok(
        !grantsDeleteOnShots(statement),
        `${migration.file} re-grants DELETE on public.shots: ${statement}`,
      );
      ok(
        !createsDeletePolicyOnShots(statement),
        `${migration.file} recreates a DELETE policy on public.shots: ${statement}`,
      );
    }
  }
});

Deno.test("shots: the pre-fix chain is the one the revoke was written against", async () => {
  const chain = await loadChain();
  const before = chain.slice(
    0,
    chain.findIndex((m) => m.file === SHOTS_DELETE_REVOKE),
  );
  const granted = before.some((m) => m.statements.some(grantsDeleteOnShots));
  ok(granted, "20260829120000 grants DELETE on shots");
});

Deno.test("cascade children and the permit sweep are indexed on their lookup columns", async () => {
  const chain = await loadChain();
  for (const index of REQUIRED_INDEXES) {
    const statements = statementsOf(chain, index.migration);
    const create = statements.find((s) =>
      s.startsWith(`create index if not exists ${index.name} `),
    );
    ok(create, `${index.migration} must create ${index.name}`);
    ok(
      index.definition.test(create),
      `${index.name} must be defined on the lookup column(s): ${create}`,
    );

    for (const migration of after(chain, index.migration)) {
      for (const statement of migration.statements) {
        ok(
          !(statement.startsWith("drop index") && statement.includes(index.name)),
          `${migration.file} drops ${index.name}`,
        );
        ok(
          !(
            statement.startsWith("drop table") &&
            new RegExp(`\\bpublic\\.${index.table}\\b`).test(statement)
          ),
          `${migration.file} drops public.${index.table}`,
        );
      }
    }
  }
});

Deno.test("permit sweep: the pg_cron predicate and the partial index stay in step", async () => {
  const chain = await loadChain();
  const cron = statementsOf(chain, SCALE_AND_SECURITY).find(
    (s) => s.includes("cron.schedule") && s.includes("expire-stale-analysis-permits"),
  );
  ok(cron, "the stale-permit sweep must be scheduled in 20260831000000");
  ok(
    cron.includes("where status = ''reserved'' and created_at <"),
    `sweep predicate must be status = 'reserved' and created_at < …: ${cron}`,
  );

  const sweepIndex = statementsOf(chain, PERMITS_SWEEP_INDEX).find((s) =>
    s.startsWith("create index if not exists analysis_permits_reserved_created_idx "),
  );
  ok(sweepIndex, "the partial sweep index must be created");
  ok(
    sweepIndex.endsWith("where status = 'reserved'"),
    `the partial index predicate must match the sweep: ${sweepIndex}`,
  );
  ok(
    sweepIndex.includes("(created_at)"),
    `the partial index must be keyed on created_at: ${sweepIndex}`,
  );
});
