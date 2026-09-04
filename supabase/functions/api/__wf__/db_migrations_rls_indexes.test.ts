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

// ─── XC-SEC-4 / XC-SEC-5: error hygiene and captures hardening ───────────────

const PROGRESS_DATA = "20260829120000_progress_data.sql";
const ERROR_HYGIENE = "20260904000000_apply_synced_shot_error_hygiene.sql";

function stripSqlComments(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Column names declared `text` inside `create table if not exists public.<table> (…)`. */
function textColumnsOf(raw: string, table: string): string[] {
  const start = raw.search(new RegExp(`create table if not exists public\\.${table}\\s*\\(`, "i"));
  ok(start >= 0, `create table public.${table} must exist`);
  const body = raw.slice(start);
  const end = body.search(/\n\);/);
  ok(end >= 0, `create table public.${table} must be terminated`);
  const columns: string[] = [];
  for (const line of body.slice(0, end).split("\n")) {
    const match = line.replace(/--.*$/, "").match(/^\s{2}([a-z_]+)\s+text\b/);
    if (match) columns.push(match[1]);
  }
  return columns;
}

/** `alter table public.<table> add constraint <name>_text_bounds check (…)`
 * statements anywhere in the chain (the defense-in-depth DO-block style is
 * split by `;` too, so each add-constraint lands in its own statement). */
function textBoundsConstraintsOn(chain: Migration[], table: string): string[] {
  const found: string[] = [];
  for (const migration of chain) {
    for (const statement of migration.statements) {
      const match = statement.match(
        new RegExp(
          `alter table public\\.${table} add constraint ([a-z_]+_text_bounds) check \\((.*)\\)(?: not valid)?$`,
        ),
      );
      if (match) found.push(match[2]);
    }
  }
  return found;
}

Deno.test(
  "apply_synced_shot: the write-failure result is SQLSTATE-only from the error-hygiene migration on",
  async () => {
    const chain = await loadChain();
    const hygiene = chain.find((m) => m.file === ERROR_HYGIENE);
    ok(hygiene, `${ERROR_HYGIENE} must exist in the migration chain`);
    const hygieneBodies = functionBodies(stripSqlComments(hygiene.raw), "apply_synced_shot");
    ok(hygieneBodies.length === 1, `${ERROR_HYGIENE} must recreate public.apply_synced_shot`);
    ok(
      /when others then\s+return 'shot\.write_failed:' \|\| sqlstate;/.test(hygieneBodies[0]),
      "the WHEN OTHERS handler must return 'shot.write_failed:' || sqlstate",
    );

    // Every later definition keeps the contract: no sqlerrm (which echoes the
    // client's input) and no message text in any return value.
    const index = chain.findIndex((m) => m.file === ERROR_HYGIENE);
    for (const migration of chain.slice(index)) {
      for (const body of functionBodies(stripSqlComments(migration.raw), "apply_synced_shot")) {
        ok(!/\bsqlerrm\b/.test(body), `${migration.file}: apply_synced_shot must not use sqlerrm`);
        ok(
          !/\bpg_exception_detail\b|\bpg_exception_hint\b|\bmessage_text\b/.test(body),
          `${migration.file}: apply_synced_shot must not surface error message text`,
        );
      }
    }
    // The pre-fix chain is the one the fix was written against.
    const ledger = chain.find((m) => m.file === IDENTITY_LEDGER);
    ok(ledger, `${IDENTITY_LEDGER} must exist`);
    ok(
      functionBodies(ledger.raw, "apply_synced_shot")[0]?.includes("|| sqlerrm"),
      `${IDENTITY_LEDGER} is the defective definition the hygiene migration supersedes`,
    );
  },
);

Deno.test("captures: every text column is covered by a *_text_bounds constraint", async () => {
  const chain = await loadChain();
  const progress = chain.find((m) => m.file === PROGRESS_DATA);
  ok(progress, `${PROGRESS_DATA} must exist in the migration chain`);
  const columns = textColumnsOf(progress.raw, "captures");
  ok(
    columns.includes("declared_stroke") && columns.includes("recognized_shot_type"),
    `captures text columns must include the client-authored ones; got ${columns.join(", ")}`,
  );
  const bounds = textBoundsConstraintsOn(chain, "captures");
  ok(bounds.length >= 1, "some migration must add a captures *_text_bounds constraint");
  for (const column of columns) {
    ok(
      bounds.some((check) => new RegExp(`length\\(${column}\\)`).test(check)),
      `captures.${column} has no length cap in any *_text_bounds constraint`,
    );
  }
});

Deno.test("captured_at: shots and captures carry a finite, sane-range check", async () => {
  const chain = await loadChain();
  const hygiene = statementsOf(chain, ERROR_HYGIENE);
  for (const table of ["shots", "captures"]) {
    const check = hygiene.find((s) =>
      new RegExp(
        `alter table public\\.${table} add constraint ${table}_captured_at_bounds check \\(`,
      ).test(s),
    );
    ok(check, `${ERROR_HYGIENE} must add ${table}_captured_at_bounds`);
    ok(
      /captured_at >= '2000-01-01'/.test(check) && /captured_at < '2100-01-01'/.test(check),
      `${table}_captured_at_bounds must bound captured_at to [2000-01-01, 2100-01-01): ${check}`,
    );
  }
});

Deno.test("captures: no client write grant survives the error-hygiene migration", async () => {
  const chain = await loadChain();
  const hygiene = statementsOf(chain, ERROR_HYGIENE);
  ok(
    hygiene.includes("revoke insert, update, delete on public.captures from anon, authenticated"),
    `${ERROR_HYGIENE} must revoke client writes on public.captures`,
  );
  for (const migration of after(chain, ERROR_HYGIENE)) {
    for (const statement of migration.statements) {
      if (!statement.startsWith("grant ")) continue;
      const [privileges, rest = ""] = statement.split(" on ", 2);
      if (!/\bpublic\.captures\b/.test(rest.split(" to ")[0] ?? "")) continue;
      const grantees = rest.split(" to ").pop() ?? "";
      ok(
        !(
          /\b(insert|update|delete|all)\b/.test(privileges) &&
          /\b(anon|authenticated|public)\b/.test(grantees)
        ),
        `${migration.file} re-grants client writes on public.captures: ${statement}`,
      );
    }
  }
});

// ─── XC-SEC-6: production edge-function dependencies are exactly pinned ──────

const FUNCTION_DIR = new URL("../", import.meta.url);
const EXACT_SEMVER_SPECIFIER = /^(npm|jsr):(@[a-z0-9-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(\/.*)?$/;
const SUPABASE_JS_PIN = "npm:@supabase/supabase-js@2.112.4";

async function productionModules(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(FUNCTION_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) files.push(entry.name);
  }
  return files.sort();
}

Deno.test(
  "edge deps: every npm:/jsr: specifier in supabase/functions/api/*.ts is an exact x.y.z",
  async () => {
    const specifiers: Array<{ file: string; specifier: string }> = [];
    for (const file of await productionModules()) {
      const source = await Deno.readTextFile(new URL(file, FUNCTION_DIR));
      for (const match of source.matchAll(/["']((?:npm|jsr):[^"']+)["']/g)) {
        specifiers.push({ file, specifier: match[1] });
      }
    }
    ok(
      specifiers.some(
        (s) => s.file === "index.ts" && s.specifier.startsWith("npm:@supabase/supabase-js@"),
      ),
      "index.ts must import supabase-js through an npm: specifier",
    );
    for (const { file, specifier } of specifiers) {
      ok(
        EXACT_SEMVER_SPECIFIER.test(specifier),
        `${file}: ${specifier} must carry an exact x.y.z version (a bare major floats every deploy)`,
      );
    }
    ok(
      specifiers.some((s) => s.specifier === SUPABASE_JS_PIN),
      `index.ts must pin ${SUPABASE_JS_PIN} (bump the pin AND deno.lock together — see AGENTS.md Deploy)`,
    );
  },
);

Deno.test(
  "edge deps: supabase/functions/api/deno.json + deno.lock pin the deploy-time resolution",
  async () => {
    const config = JSON.parse(await Deno.readTextFile(new URL("deno.json", FUNCTION_DIR)));
    ok(config.lock !== false, "supabase/functions/api/deno.json must not disable the lockfile");
    const lock = JSON.parse(await Deno.readTextFile(new URL("deno.lock", FUNCTION_DIR)));
    const specifiers = lock.specifiers ?? {};
    ok(
      specifiers[SUPABASE_JS_PIN] === SUPABASE_JS_PIN.split("@").pop(),
      `deno.lock must resolve ${SUPABASE_JS_PIN} to itself; got ${JSON.stringify(specifiers)}`,
    );
    for (const key of Object.keys(specifiers)) {
      ok(
        !/^npm:@supabase\/supabase-js@(\d+|\^|~)/.test(key) || key === SUPABASE_JS_PIN,
        `deno.lock records a floating supabase-js specifier: ${key}`,
      );
    }
  },
);
