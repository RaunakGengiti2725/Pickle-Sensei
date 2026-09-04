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
const RLS_BLIND_REVOKE = "20260905000001_revoke_rls_blind_privileges.sql";
const PERMIT_LIFECYCLE = "20260905000002_permit_lifecycle_one_way.sql";

/** The tables apply_synced_shot() writes. A client session must hold no
 * INSERT on any of them: the RPC is the only writer. */
const SYNC_WRITTEN_TABLES = [
  "shots",
  "shot_phases",
  "shot_checkpoints",
  "shot_measurements",
] as const;

/** Privileges RLS does not govern. No client role may hold them on any
 * public table, and the schema defaults must stop handing them out. */
const RLS_BLIND_PRIVILEGES = ["truncate", "trigger", "references"] as const;

/** The full analysis_permits.outcome vocabulary: what the sync RPC and the
 * sweep write, plus the releasable outcomes POST /v1/permits/:id/finalize
 * accepts (index.ts RELEASABLE_OUTCOMES). */
const PERMIT_OUTCOMES = [
  "scored",
  "low_confidence",
  "expired",
  "free_limit_exceeded",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
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

/** `grant <privileges> on <objects> to <grantees>` split into its three
 * parts, or null when the statement is not a GRANT. Column-level grants
 * (`grant update (status, outcome) on …`) keep their column list inside
 * `privileges`. */
function parseGrant(
  statement: string,
): { privileges: string; objects: string; grantees: string } | null {
  if (!statement.startsWith("grant ")) return null;
  const onIndex = statement.indexOf(" on ");
  const toIndex = statement.lastIndexOf(" to ");
  if (onIndex < 0 || toIndex < onIndex) return null;
  return {
    privileges: statement.slice("grant ".length, onIndex),
    objects: statement.slice(onIndex + " on ".length, toIndex),
    grantees: statement.slice(toIndex + " to ".length),
  };
}

function grantsToClientRole(grantees: string): boolean {
  return /\b(anon|authenticated|public)\b/.test(grantees);
}

/** A GRANT that hands INSERT (or ALL) on one of the sync-written tables to a
 * client role, whether named directly or via `all tables in schema public`. */
function grantsClientInsertOnSyncTables(statement: string): boolean {
  const grant = parseGrant(statement);
  if (!grant) return false;
  if (!/\binsert\b/.test(grant.privileges) && !/\ball\b/.test(grant.privileges)) {
    return false;
  }
  if (!grantsToClientRole(grant.grantees)) return false;
  if (/\ball tables in schema public\b/.test(grant.objects)) return true;
  return SYNC_WRITTEN_TABLES.some((table) =>
    new RegExp(`\\bpublic\\.${table}\\b`).test(grant.objects),
  );
}

/** A GRANT that hands TRUNCATE / TRIGGER / REFERENCES (or ALL) on anything
 * in schema public to a client role. */
function grantsRlsBlindPrivilegeToClient(statement: string): boolean {
  const grant = parseGrant(statement);
  if (!grant) return false;
  if (!/\bpublic\./.test(grant.objects) && !/\bschema public\b/.test(grant.objects)) {
    return false;
  }
  if (!grantsToClientRole(grant.grantees)) return false;
  if (/\ball\b/.test(grant.privileges) && !/\(/.test(grant.privileges)) return true;
  return RLS_BLIND_PRIVILEGES.some((p) => new RegExp(`\\b${p}\\b`).test(grant.privileges));
}

function createsInsertPolicyOnSyncTables(statement: string): boolean {
  return (
    statement.startsWith("create policy") &&
    /\bfor insert\b/.test(statement) &&
    SYNC_WRITTEN_TABLES.some((table) => new RegExp(`\\bon public\\.${table}\\b`).test(statement))
  );
}

/** The `security definer` / `security invoker` mode of a function body. */
function securityModeOf(body: string): "definer" | "invoker" | null {
  if (/\bsecurity definer\b/.test(body)) return "definer";
  if (/\bsecurity invoker\b/.test(body)) return "invoker";
  return null;
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

Deno.test(
  "shots: INSERT is revoked from the client role and only apply_synced_shot() (definer, pinned) writes the sync tables",
  async () => {
    const chain = await loadChain();
    const fix = chain.find((m) => m.file === SHOTS_INSERT_VIA_RPC);
    ok(fix, `${SHOTS_INSERT_VIA_RPC} must exist in the migration chain`);

    for (const table of SYNC_WRITTEN_TABLES) {
      ok(
        fix.statements.some(
          (s) =>
            s.startsWith("revoke ") &&
            /\binsert\b/.test(s.split(" on ", 2)[0]) &&
            new RegExp(`\\bpublic\\.${table}\\b`).test(s.split(" on ", 2)[1] ?? "") &&
            /\bfrom\b.*\bauthenticated\b/.test(s),
        ),
        `${SHOTS_INSERT_VIA_RPC} must revoke INSERT on public.${table} from authenticated`,
      );
      ok(
        fix.statements.includes(`drop policy if exists "${table}_insert_own" on public.${table}`),
        `${SHOTS_INSERT_VIA_RPC} must drop the ${table}_insert_own policy`,
      );
    }

    // The RPC is recreated as SECURITY DEFINER with an empty search_path — the
    // ONLY INSERT authority on the sync tables — and stays client-executable.
    const bodies = functionBodies(fix.raw, "apply_synced_shot");
    ok(bodies.length === 1, `${SHOTS_INSERT_VIA_RPC} must recreate public.apply_synced_shot`);
    ok(securityModeOf(bodies[0]) === "definer", "apply_synced_shot must be SECURITY DEFINER");
    ok(bodies[0].includes("set search_path = ''"), "apply_synced_shot must pin search_path");
    ok(
      bodies[0].includes("public.lifetime_scored_count()"),
      "apply_synced_shot must still count through the identity ledger",
    );
    ok(
      fix.statements.some((s) =>
        /^revoke all on function public\.apply_synced_shot\(jsonb\) from public, anon\b/.test(s),
      ) &&
        fix.statements.includes(
          "grant execute on function public.apply_synced_shot(jsonb) to authenticated",
        ),
      "apply_synced_shot execute must be authenticated-only",
    );

    // From here on: no client INSERT grant on the sync tables, no INSERT
    // policy, and every later redefinition of the RPC stays definer + pinned.
    for (const migration of after(chain, SHOTS_INSERT_VIA_RPC)) {
      for (const statement of migration.statements) {
        ok(
          !grantsClientInsertOnSyncTables(statement),
          `${migration.file} re-grants client INSERT on a sync-written table: ${statement}`,
        );
        ok(
          !createsInsertPolicyOnSyncTables(statement),
          `${migration.file} recreates a client INSERT policy on a sync-written table: ${statement}`,
        );
      }
      for (const body of functionBodies(migration.raw, "apply_synced_shot")) {
        ok(
          securityModeOf(body) === "definer" && body.includes("set search_path = ''"),
          `${migration.file}: apply_synced_shot must stay SECURITY DEFINER with search_path = ''`,
        );
      }
    }
  },
);

Deno.test(
  "grants: TRUNCATE/TRIGGER/REFERENCES are revoked from the client roles everywhere, defaults included, and never re-granted",
  async () => {
    const chain = await loadChain();
    const fix = chain.find((m) => m.file === RLS_BLIND_REVOKE);
    ok(fix, `${RLS_BLIND_REVOKE} must exist in the migration chain`);

    // Every existing table: a loop over pg_class (so views and tables added
    // by any earlier migration are covered), revoking the three privileges
    // from both client roles.
    ok(
      /revoke truncate, trigger, references on %s from anon, authenticated/.test(fix.raw) &&
        /from pg_class/.test(fix.raw),
      `${RLS_BLIND_REVOKE} must revoke truncate, trigger, references from anon, authenticated on every public relation`,
    );
    // Future tables: the schema default privileges no longer carry them.
    ok(
      fix.statements.includes(
        "alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated",
      ),
      `${RLS_BLIND_REVOKE} must revoke the three privileges from the schema default privileges`,
    );
    // Captures hygiene: no client path updates or deletes captures.
    ok(
      fix.statements.includes("revoke update, delete on public.captures from authenticated"),
      `${RLS_BLIND_REVOKE} must revoke UPDATE/DELETE on captures from authenticated`,
    );

    for (const migration of after(chain, RLS_BLIND_REVOKE)) {
      for (const statement of migration.statements) {
        ok(
          !grantsRlsBlindPrivilegeToClient(statement),
          `${migration.file} grants TRUNCATE/TRIGGER/REFERENCES (or ALL) to a client role: ${statement}`,
        );
        ok(
          !(
            statement.startsWith("alter default privileges") &&
            /\bgrant\b/.test(statement) &&
            grantsToClientRole(statement.split(" to ").pop() ?? "") &&
            (/\ball\b/.test(statement) ||
              RLS_BLIND_PRIVILEGES.some((p) => new RegExp(`\\b${p}\\b`).test(statement)))
          ),
          `${migration.file} reopens the default privileges for a client role: ${statement}`,
        );
      }
    }
  },
);

Deno.test(
  "permits: the lifecycle guard trigger and the outcome vocabulary are installed and never removed",
  async () => {
    const chain = await loadChain();
    const fix = chain.find((m) => m.file === PERMIT_LIFECYCLE);
    ok(fix, `${PERMIT_LIFECYCLE} must exist in the migration chain`);

    const trigger = fix.statements.find((s) =>
      s.startsWith("create trigger analysis_permits_lifecycle_guard "),
    );
    ok(trigger, `${PERMIT_LIFECYCLE} must create analysis_permits_lifecycle_guard`);
    ok(
      /\bbefore update on public\.analysis_permits for each row\b/.test(trigger),
      `the guard must be a BEFORE UPDATE row trigger on analysis_permits: ${trigger}`,
    );
    ok(
      functionBodies(fix.raw, "guard_analysis_permit_lifecycle").length === 1,
      `${PERMIT_LIFECYCLE} must define public.guard_analysis_permit_lifecycle()`,
    );
    ok(
      fix.statements.some((s) =>
        /^revoke all on function public\.guard_analysis_permit_lifecycle\(\) from public, anon, authenticated\b/.test(
          s,
        ),
      ),
      "the guard function must not be client-executable",
    );

    const outcomeCheck = fix.statements.find(
      (s) =>
        s.startsWith(
          "alter table public.analysis_permits add constraint analysis_permits_outcome_check",
        ) && /\bcheck\b/.test(s),
    );
    ok(outcomeCheck, `${PERMIT_LIFECYCLE} must add analysis_permits_outcome_check`);
    for (const outcome of PERMIT_OUTCOMES) {
      ok(
        outcomeCheck.includes(`'${outcome}'`),
        `outcome check must list '${outcome}': ${outcomeCheck}`,
      );
    }
    // Exactly the documented vocabulary — nothing extra may slip in.
    const listed = outcomeCheck.match(/'[a-z_]+'/g) ?? [];
    const extras = listed
      .map((v) => v.slice(1, -1))
      .filter((v) => v !== "reserved" && !(PERMIT_OUTCOMES as readonly string[]).includes(v));
    ok(extras.length === 0, `outcome check lists undocumented values: ${extras.join(", ")}`);

    for (const migration of after(chain, PERMIT_LIFECYCLE)) {
      for (const statement of migration.statements) {
        ok(
          !(
            statement.startsWith("drop trigger") &&
            statement.includes("analysis_permits_lifecycle_guard") &&
            !migration.statements.some((s) =>
              s.startsWith("create trigger analysis_permits_lifecycle_guard "),
            )
          ),
          `${migration.file} drops the permit lifecycle guard without recreating it`,
        );
        ok(
          !(
            /^alter table public\.analysis_permits drop constraint (if exists )?analysis_permits_outcome_check\b/.test(
              statement,
            ) &&
            !migration.statements.some((s) =>
              s.startsWith(
                "alter table public.analysis_permits add constraint analysis_permits_outcome_check",
              ),
            )
          ),
          `${migration.file} drops the outcome vocabulary without replacing it`,
        );
        ok(
          !(
            statement.startsWith("alter table public.analysis_permits disable trigger") &&
            /\b(all|user|analysis_permits_lifecycle_guard)\b/.test(statement)
          ),
          `${migration.file} disables the permit lifecycle guard: ${statement}`,
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
