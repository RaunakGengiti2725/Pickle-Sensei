// Static pins over the migration chain in supabase/migrations. The live
// behaviour (grant layer, quota, planner, identity ledger) is asserted by
// supabase/tests/security_regression.sql cases H7, I1–I3 and J1–J9 against a
// real Postgres; this suite guards the chain itself so a later migration
// cannot quietly reopen a closed path, drop a load-bearing index, or recreate
// a free-rating decision point on the raw per-account count.
//
//   deno test --no-config --allow-read supabase/functions/api/__wf__/

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MIGRATIONS_DIR = new URL("../../../migrations/", import.meta.url);

const SHOTS_DELETE_REVOKE = "20260902130000_shots_delete_revoke.sql";
const CASCADE_USER_INDEXES = "20260902130100_cascade_user_indexes.sql";
const PERMITS_SWEEP_INDEX = "20260902130200_permits_reserved_sweep_index.sql";
const SCALE_AND_SECURITY = "20260831000000_scale_and_security.sql";
const IDENTITY_LEDGER = "20260902150000_free_rating_identity_ledger.sql";
const SHOTS_INSERT_VIA_RPC = "20260905000000_shots_insert_only_via_rpc.sql";
const REVOKE_RLS_BLIND = "20260905000001_revoke_rls_blind_privileges.sql";
const PERMIT_LIFECYCLE = "20260905000002_permit_lifecycle_one_way.sql";

/** The permit outcomes the edge fn, the sync RPC and the pg_cron sweep
 * write. The lifecycle migration must confine analysis_permits.outcome to
 * exactly this set (in any order). */
const PERMIT_OUTCOMES = [
  "scored",
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
  "expired",
  "free_limit_exceeded",
] as const;

/** The three places the two-lifetime-free-ratings rule is decided. Every
 * definition of these from the ledger migration onward must count through
 * lifetime_scored_count() — a raw `count(*) from public.shots` in any of them
 * reopens the delete-and-recreate hole the ledger closes. */
const FREE_RATING_DECISION_POINTS = [
  "access_state",
  "reserve_analysis_permit",
  "apply_synced_shot",
] as const;

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

type Migration = { file: string; statements: string[]; raw: string };

/** Every `create or replace function public.<name>(` … `$$;` body in a
 * migration, lower-cased (dollar-quoted bodies are split by `;` in
 * normalizeSql, so function-level pins read the raw text instead). */
function functionBodies(raw: string, name: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(
    `create or replace function public\\.${name}\\s*\\([\\s\\S]*?\\$\\$;`,
    "gi",
  );
  for (const match of raw.matchAll(re)) bodies.push(match[0].toLowerCase());
  return bodies;
}

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
    chain.push({ file, statements: normalizeSql(sql), raw: sql });
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

function grantsInsertOnShots(statement: string): boolean {
  if (!statement.startsWith("grant ")) return false;
  const [privileges, rest = ""] = statement.split(" on ", 2);
  if (!/\binsert\b/.test(privileges) && !/\ball\b/.test(privileges)) {
    return false;
  }
  const [objects, grantees = ""] = rest.split(" to ", 2);
  return /\bpublic\.shots\b/.test(objects) && /\b(anon|authenticated|public)\b/.test(grantees);
}

function dropsShotsInsertGuard(statement: string): boolean {
  return (
    statement.startsWith("drop trigger") &&
    statement.includes("shots_insert_only_via_rpc") &&
    /\bon public\.shots\b/.test(statement)
  );
}

Deno.test(
  "shots: a client session can only INSERT through apply_synced_shot(), and no later migration reopens it",
  async () => {
    const chain = await loadChain();
    const guard = chain.find((m) => m.file === SHOTS_INSERT_VIA_RPC);
    ok(guard, `${SHOTS_INSERT_VIA_RPC} must exist in the migration chain`);

    // The RPC stays SECURITY INVOKER (RLS + caller grants apply), so the
    // authenticated INSERT grant has to survive for the RPC's own insert —
    // the direct path is closed by a BEFORE INSERT guard on the table that
    // only the RPC can satisfy. Both halves must be present, and the RPC body
    // must keep counting through the identity ledger (asserted below).
    const createsGuard = guard.statements.some(
      (s) =>
        s.startsWith("create trigger shots_insert_only_via_rpc before insert on public.shots") &&
        s.includes("for each row execute function public.shots_insert_only_via_rpc()"),
    );
    ok(
      createsGuard,
      "the guard migration must attach a BEFORE INSERT trigger shots_insert_only_via_rpc to public.shots",
    );
    ok(
      functionBodies(guard.raw, "shots_insert_only_via_rpc").length === 1,
      "the guard migration must define public.shots_insert_only_via_rpc()",
    );
    ok(
      guard.statements.includes(
        "revoke all on function public.shots_insert_only_via_rpc() from public, anon, authenticated",
      ),
      "the guard function must not be client-executable",
    );
    const rpc = functionBodies(guard.raw, "apply_synced_shot");
    ok(
      rpc.length === 1,
      "the guard migration must recreate public.apply_synced_shot() to satisfy the guard",
    );
    ok(rpc[0].includes("security invoker"), "apply_synced_shot must stay SECURITY INVOKER");
    ok(
      rpc[0].includes("set_config('pickle.apply_synced_shot'"),
      "apply_synced_shot must arm the insert guard for exactly the row it writes",
    );

    for (const migration of after(chain, SHOTS_INSERT_VIA_RPC)) {
      for (const statement of migration.statements) {
        ok(
          !dropsShotsInsertGuard(statement) ||
            migration.statements.some((s) =>
              s.startsWith(
                "create trigger shots_insert_only_via_rpc before insert on public.shots",
              ),
            ),
          `${migration.file} drops the shots insert guard without recreating it: ${statement}`,
        );
        ok(
          !(
            statement.startsWith("drop function") &&
            statement.includes("public.shots_insert_only_via_rpc")
          ),
          `${migration.file} drops the shots insert guard function: ${statement}`,
        );
        ok(
          !(
            statement.startsWith("alter table public.shots") &&
            /\bdisable trigger\b/.test(statement)
          ),
          `${migration.file} disables triggers on public.shots: ${statement}`,
        );
      }
    }

    // The INSERT grant the RPC relies on already exists (20260829120000); a
    // later migration re-granting it is the signature of someone reopening the
    // direct path on purpose and must be reviewed alongside the guard.
    const grantsAfterGuard = after(chain, SHOTS_INSERT_VIA_RPC).flatMap((m) =>
      m.statements.filter(grantsInsertOnShots).map((s) => `${m.file}: ${s}`),
    );
    ok(
      grantsAfterGuard.length === 0,
      `no migration after the guard may re-grant INSERT on public.shots to a client role:\n${grantsAfterGuard.join("\n")}`,
    );
  },
);

Deno.test(
  "grants: anon/authenticated lose TRUNCATE/TRIGGER/REFERENCES on every public table, present and future",
  async () => {
    const chain = await loadChain();
    const revoke = statementsOf(chain, REVOKE_RLS_BLIND);
    ok(
      revoke.includes(
        "alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated",
      ),
      "the revoke migration must alter default privileges so future tables inherit the same shape",
    );
    const raw = chain.find((m) => m.file === REVOKE_RLS_BLIND)?.raw.toLowerCase() ?? "";
    ok(
      raw.includes("revoke truncate, trigger, references on public.%i from anon, authenticated"),
      "the revoke migration must iterate every existing public relation (format('... public.%I ...'))",
    );

    const blind = /\b(truncate|trigger|references|all)\b/;
    for (const migration of after(chain, REVOKE_RLS_BLIND)) {
      for (const statement of migration.statements) {
        if (!statement.startsWith("grant ")) continue;
        const [privileges, rest = ""] = statement.split(" on ", 2);
        const grantees = rest.split(" to ", 2)[1] ?? "";
        ok(
          !(
            blind.test(privileges) &&
            /\b(anon|authenticated|public)\b/.test(grantees) &&
            !/\bon function\b/.test(statement) &&
            !/\bon schema\b/.test(statement) &&
            !/\bon sequence\b/.test(statement)
          ),
          `${migration.file} hands an RLS-blind privilege back to a client role: ${statement}`,
        );
      }
    }
  },
);

Deno.test(
  "permits: the lifecycle is one-way and outcome is confined to the known set",
  async () => {
    const chain = await loadChain();
    const lifecycle = chain.find((m) => m.file === PERMIT_LIFECYCLE);
    ok(lifecycle, `${PERMIT_LIFECYCLE} must exist in the migration chain`);
    ok(
      lifecycle.statements.some(
        (s) =>
          s.startsWith(
            "create trigger analysis_permits_lifecycle_one_way before update on public.analysis_permits",
          ) && s.includes("for each row execute function public.enforce_permit_lifecycle()"),
      ),
      "the lifecycle migration must attach a BEFORE UPDATE trigger to public.analysis_permits",
    );
    const bodies = functionBodies(lifecycle.raw, "enforce_permit_lifecycle");
    ok(
      bodies.length === 1,
      "the lifecycle migration must define public.enforce_permit_lifecycle()",
    );
    ok(
      /old\.status\s*<>\s*'reserved'/.test(bodies[0]) ||
        /old\.status\s*(!=|<>)\s*'reserved'/.test(bodies[0]),
      "the guard must reject any change to a permit that is no longer reserved",
    );
    ok(
      lifecycle.statements.includes(
        "revoke all on function public.enforce_permit_lifecycle() from public, anon, authenticated",
      ),
      "the guard function must not be client-executable",
    );

    const check = lifecycle.statements.find((s) =>
      s.startsWith(
        "alter table public.analysis_permits add constraint analysis_permits_outcome_known check",
      ),
    );
    ok(
      check,
      "the lifecycle migration must add the analysis_permits_outcome_known check constraint",
    );
    const listed = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    const expected = [...PERMIT_OUTCOMES].sort();
    ok(
      JSON.stringify(listed) === JSON.stringify(expected),
      `outcome enumeration must be exactly ${expected.join(", ")} (got ${listed.join(", ")})`,
    );

    for (const migration of after(chain, PERMIT_LIFECYCLE)) {
      for (const statement of migration.statements) {
        ok(
          !(
            statement.startsWith("drop trigger") &&
            statement.includes("analysis_permits_lifecycle_one_way") &&
            !migration.statements.some((s) =>
              s.startsWith(
                "create trigger analysis_permits_lifecycle_one_way before update on public.analysis_permits",
              ),
            )
          ),
          `${migration.file} drops the permit lifecycle guard without recreating it`,
        );
        ok(
          !(
            statement.startsWith("alter table public.analysis_permits") &&
            statement.includes("drop constraint analysis_permits_outcome_known")
          ),
          `${migration.file} drops the outcome enumeration: ${statement}`,
        );
      }
    }
  },
);

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

Deno.test(
  "free ratings: every decision point counts through the identity ledger, from the ledger migration on",
  async () => {
    const chain = await loadChain();
    const ledgerIndex = chain.findIndex((m) => m.file === IDENTITY_LEDGER);
    ok(ledgerIndex >= 0, `${IDENTITY_LEDGER} must exist in the migration chain`);
    const ledger = chain[ledgerIndex];

    // The ledger migration itself: table, writer trigger, helper, and all three
    // decision points redefined on top of lifetime_scored_count().
    ok(
      ledger.statements.some((s) =>
        s.startsWith("create table if not exists public.free_rating_ledger "),
      ),
      "the ledger migration must create public.free_rating_ledger",
    );
    ok(
      ledger.statements.includes(
        "revoke all on public.free_rating_ledger from public, anon, authenticated",
      ),
      "the ledger must carry no client grants",
    );
    ok(
      ledger.statements.some((s) =>
        s.startsWith(
          "create trigger shots_record_free_rating_ledger after insert or update of result_kind on public.shots",
        ),
      ),
      "the ledger must be written by a trigger on scored shot inserts",
    );
    ok(
      functionBodies(ledger.raw, "lifetime_scored_count").length === 1,
      "the ledger migration must define lifetime_scored_count()",
    );
    for (const name of FREE_RATING_DECISION_POINTS) {
      const bodies = functionBodies(ledger.raw, name);
      ok(bodies.length === 1, `${IDENTITY_LEDGER} must recreate public.${name}`);
    }

    // From here on, any redefinition of a decision point must keep counting
    // through lifetime_scored_count() and must not reintroduce the raw count.
    const rawCount = /count\(\*\)[^;]*from public\.shots/;
    for (const migration of chain.slice(ledgerIndex)) {
      for (const name of FREE_RATING_DECISION_POINTS) {
        for (const body of functionBodies(migration.raw, name)) {
          ok(
            body.includes("public.lifetime_scored_count()"),
            `${migration.file}: public.${name} must count through public.lifetime_scored_count()`,
          );
          ok(
            !rawCount.test(body),
            `${migration.file}: public.${name} counts public.shots directly, bypassing the identity ledger`,
          );
        }
      }
      if (migration.file === IDENTITY_LEDGER) continue;
      for (const statement of migration.statements) {
        ok(
          !(statement.startsWith("drop table") && /\bpublic\.free_rating_ledger\b/.test(statement)),
          `${migration.file} drops public.free_rating_ledger`,
        );
        ok(
          !(
            statement.startsWith("drop trigger") &&
            statement.includes("shots_record_free_rating_ledger") &&
            !migration.statements.some((s) =>
              s.startsWith("create trigger shots_record_free_rating_ledger "),
            )
          ),
          `${migration.file} drops the ledger trigger without recreating it`,
        );
        ok(
          !(
            statement.startsWith("grant ") &&
            /\bpublic\.free_rating_ledger\b/.test(statement) &&
            /\b(anon|authenticated|public)\b/.test(statement.split(" to ").pop() ?? "")
          ),
          `${migration.file} grants client access to public.free_rating_ledger: ${statement}`,
        );
      }
    }
  },
);
