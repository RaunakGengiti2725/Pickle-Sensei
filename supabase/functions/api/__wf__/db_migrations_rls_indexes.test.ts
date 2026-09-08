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
const SCORED_WRITE_GATE = "20260905000000_scored_shot_write_gate.sql";
const LATE_LINK_LEDGER = "20260905000100_late_linked_identity_ledger.sql";
const LATE_PERMIT_SYNC = "20260906130000_late_permit_sync_durability.sql";
const PERMIT_LIFECYCLE = "20260906140000_permit_lifecycle_null_safe.sql";
const PERMIT_TERMINAL = "20260907000000_permit_terminal_client_role.sql";
const PERMIT_SETTLED_NO_DELETE = "20260907100000_permit_settled_no_delete.sql";
const ANALYSIS_RELEASE_AUTHORITY = "20260908020000_analysis_release_authority.sql";
const PERMIT_PARTIAL_OUTCOME = "20260908100000_permit_partial_terminal_outcome.sql";
const OFFLINE_DEVICE_GRANTS = "20260908120000_offline_device_grants.sql";

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
    `create(?: or replace)? function public\\.${name}\\s*\\([\\s\\S]*?\\$\\$;`,
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

// ─── DB-02 / DB-01: table-layer permit gate and link-time ledger inheritance ──

/** A later migration may drop one of these triggers only if it recreates it in
 * the same file (the `drop trigger if exists … create trigger …` idiom). */
function dropsTriggerWithoutRecreating(migration: Migration, trigger: string): boolean {
  return migration.statements.some(
    (s) =>
      s.startsWith("drop trigger") &&
      s.includes(trigger) &&
      !migration.statements.some((c) => c.startsWith(`create trigger ${trigger} `)),
  );
}

Deno.test(
  "shots: every client-written scored row passes the permit gate, and abstentions carry no score",
  async () => {
    const chain = await loadChain();
    const gate = statementsOf(chain, SCORED_WRITE_GATE);
    const gateRaw = chain.find((m) => m.file === SCORED_WRITE_GATE)?.raw ?? "";
    ok(
      gate.some((s) =>
        s.startsWith(
          "create trigger shots_enforce_scored_permit before insert on public.shots for each row execute function public.enforce_scored_shot_permit()",
        ),
      ),
      `${SCORED_WRITE_GATE} must install the BEFORE INSERT gate on public.shots`,
    );
    ok(
      gate.includes(
        "revoke execute on function public.enforce_scored_shot_permit() from public, anon, authenticated",
      ),
      "the gate function must not be client-executable",
    );
    ok(
      /alter table public\.shots add constraint shots_low_confidence_unscored check \(\s*result_kind = 'scored' or overall_score is null\s*\) not valid/.test(
        gateRaw.toLowerCase(),
      ),
      `${SCORED_WRITE_GATE} must add shots_low_confidence_unscored (NOT VALID — no deploy-time rescan)`,
    );
    const [body] = functionBodies(gateRaw, "enforce_scored_shot_permit");
    ok(body, `${SCORED_WRITE_GATE} must define enforce_scored_shot_permit()`);
    ok(
      body.includes("pg_advisory_xact_lock(public.access_lock_key("),
      "the gate must serialize on the shared per-user access lock (a direct writer racing a sync must not double-spend)",
    );
    ok(
      body.includes("public.lifetime_scored_count()") &&
        !/count\(\*\)[^;]*from public\.shots/.test(body),
      "the gate must decide the allowance through lifetime_scored_count(), never the raw per-account count",
    );
    ok(
      /p\.status = 'reserved'/.test(body) && /interval '24 hours'/.test(body),
      "the gate must require a LIVE reserved permit (same 24h window as apply_synced_shot)",
    );
    for (const migration of after(chain, SCORED_WRITE_GATE)) {
      ok(
        !dropsTriggerWithoutRecreating(migration, "shots_enforce_scored_permit"),
        `${migration.file} drops shots_enforce_scored_permit without recreating it`,
      );
      ok(
        !migration.statements.some(
          (s) =>
            s.startsWith("alter table public.shots drop constraint") &&
            s.includes("shots_low_confidence_unscored"),
        ),
        `${migration.file} drops shots_low_confidence_unscored`,
      );
      for (const body of functionBodies(migration.raw, "enforce_scored_shot_permit")) {
        ok(
          body.includes("public.lifetime_scored_count()") && /p\.status = 'reserved'/.test(body),
          `${migration.file}: enforce_scored_shot_permit must keep both the permit check and the lifetime allowance`,
        );
      }
    }
  },
);

Deno.test(
  "free ratings: an identity linked after the ratings were spent inherits the ledger at link time",
  async () => {
    const chain = await loadChain();
    const link = statementsOf(chain, LATE_LINK_LEDGER);
    const linkRaw = chain.find((m) => m.file === LATE_LINK_LEDGER)?.raw ?? "";
    ok(
      link.some((s) =>
        s.startsWith(
          "create trigger on_auth_identity_linked after insert on auth.identities for each row execute function public.inherit_free_rating_ledger()",
        ),
      ),
      `${LATE_LINK_LEDGER} must install the AFTER INSERT trigger on auth.identities`,
    );
    ok(
      link.includes(
        "revoke execute on function public.inherit_free_rating_ledger() from public, anon, authenticated",
      ),
      "inherit_free_rating_ledger() must not be client-executable",
    );
    const [body] = functionBodies(linkRaw, "inherit_free_rating_ledger");
    ok(body, `${LATE_LINK_LEDGER} must define inherit_free_rating_ledger()`);
    ok(
      body.includes("security definer"),
      "the link-time writer runs as definer (GoTrue holds no ledger grant)",
    );
    ok(
      /set scored_count = greatest\(led\.scored_count, excluded\.scored_count\)/.test(body),
      "the link-time writer must never decrement a ledger row",
    );
    ok(
      link.some(
        (s) =>
          s.startsWith("with per_user as") && s.includes("insert into public.free_rating_ledger"),
      ),
      `${LATE_LINK_LEDGER} must backfill existing accounts' identities to their lifetime count`,
    );
    for (const migration of after(chain, LATE_LINK_LEDGER)) {
      ok(
        !dropsTriggerWithoutRecreating(migration, "on_auth_identity_linked"),
        `${migration.file} drops on_auth_identity_linked without recreating it`,
      );
    }
  },
);

// ─── OFF-24H-01: a late permit backs its shot; the direct-INSERT gate stays shut ──

/** The exact backing rule for a late sync: reserved at any age, or swept to
 * released/expired. Anything else is refused. */
const LATE_BACKING_RULE =
  /status = 'reserved'\s+or \(\s*\S*status = 'released' and \S*outcome = 'expired'\s*\)/;

Deno.test(
  "apply_synced_shot: permit age never refuses a sync, and the shots gate honours only the RPC's vouch",
  async () => {
    const chain = await loadChain();
    const late = chain.find((m) => m.file === LATE_PERMIT_SYNC);
    ok(late, `${LATE_PERMIT_SYNC} must exist in the migration chain`);
    const raw = stripSqlComments(late.raw);

    const [rpc] = functionBodies(raw, "apply_synced_shot");
    ok(rpc, `${LATE_PERMIT_SYNC} must recreate public.apply_synced_shot`);
    ok(
      !rpc.includes("access.permit_expired") && !/created_at <= now\(\)/.test(rpc),
      "apply_synced_shot must not refuse a permit on age (access.permit_expired is retired)",
    );
    ok(
      LATE_BACKING_RULE.test(rpc) && rpc.includes("return 'access.permit_not_reserved'"),
      "apply_synced_shot must accept exactly reserved | released+expired and refuse every other state",
    );
    ok(
      rpc.includes("set_config('pickle.sync_permit_id', v_permit_id::text, true)") &&
        rpc.includes("set_config('pickle.sync_permit_id', '', true)"),
      "apply_synced_shot must vouch for the validated permit transaction-locally and clear the vouch",
    );
    ok(
      rpc.includes("public.lifetime_scored_count() >= 2") &&
        rpc.includes("return 'access.paywall_required'"),
      "the free-limit backstop must remain the guard that caps free ratings",
    );

    const [gate] = functionBodies(raw, "enforce_scored_shot_permit");
    ok(gate, `${LATE_PERMIT_SYNC} must recreate public.enforce_scored_shot_permit`);
    ok(
      gate.includes("current_setting('pickle.sync_permit_id', true)") &&
        gate.includes("p.id = v_vouched") &&
        LATE_BACKING_RULE.test(gate),
      "the gate must honour the vouch only for the one permit the RPC validated, under the same backing rule",
    );
    ok(
      /p\.status = 'reserved'\s+and p\.created_at > now\(\) - interval '24 hours'/.test(gate),
      "the gate must keep the live-permit rule for direct client INSERTs (no vouch → 24h window)",
    );
    ok(
      late.statements.includes(
        "revoke execute on function public.enforce_scored_shot_permit() from public, anon, authenticated",
      ),
      "the recreated gate function must stay non-executable by clients",
    );

    // Later definitions must not reintroduce an age refusal in the RPC or
    // loosen the gate's direct-INSERT rule. From 20260906140000 on the backing
    // rule lives in permit_backs_sync() (pinned below) — a later RPC either
    // delegates to it or spells the same rule inline.
    for (const migration of after(chain, LATE_PERMIT_SYNC)) {
      for (const body of functionBodies(stripSqlComments(migration.raw), "apply_synced_shot")) {
        ok(
          !body.includes("access.permit_expired") &&
            (LATE_BACKING_RULE.test(body) || body.includes("public.permit_backs_sync(")),
          `${migration.file}: apply_synced_shot must keep accepting reserved | released+expired permits at any age`,
        );
      }
      for (const body of functionBodies(
        stripSqlComments(migration.raw),
        "enforce_scored_shot_permit",
      )) {
        ok(
          /p\.status = 'reserved'\s+and p\.created_at > now\(\) - interval '24 hours'/.test(body),
          `${migration.file}: enforce_scored_shot_permit must keep the 24h live-permit rule for direct INSERTs`,
        );
      }
    }
  },
);

// ─── OFF-24H-02: NULL-safe backing, closed permit lifecycle, vouch-only gate ──

/** permit_backs_sync(): the late backing rule wrapped so NULL → false. */
const NULL_SAFE_BACKING_RULE =
  /coalesce\(\s*p_status = 'reserved'\s+or \(p_status = 'released' and p_outcome = 'expired'\),\s*false\)/;

Deno.test(
  "permits: backing is decided by the NULL-safe permit_backs_sync(), the lifecycle is a table invariant, and the sync gate never falls back to an unrelated permit",
  async () => {
    const chain = await loadChain();
    const migration = chain.find((m) => m.file === PERMIT_LIFECYCLE);
    ok(migration, `${PERMIT_LIFECYCLE} must exist in the migration chain`);
    const raw = stripSqlComments(migration.raw);

    const [rule] = functionBodies(raw, "permit_backs_sync");
    ok(rule, `${PERMIT_LIFECYCLE} must define public.permit_backs_sync`);
    ok(
      NULL_SAFE_BACKING_RULE.test(rule),
      "permit_backs_sync must be coalesce(reserved | released+expired, false): a NULL outcome is refused",
    );

    // Every status/outcome decision in the RPC and the gate goes through it;
    // the 3VL-prone inline comparison is gone from both.
    const [rpc] = functionBodies(raw, "apply_synced_shot");
    ok(rpc, `${PERMIT_LIFECYCLE} must recreate public.apply_synced_shot`);
    ok(
      rpc.includes("if not public.permit_backs_sync(v_permit.status, v_permit.outcome) then") &&
        rpc.includes("return 'access.permit_not_reserved'") &&
        !rpc.includes("outcome = 'expired'"),
      "apply_synced_shot must validate the named permit through permit_backs_sync only",
    );
    ok(
      (rpc.match(/and public\.permit_backs_sync\(status, outcome\)/g) ?? []).length === 2,
      "both permit UPDATEs in apply_synced_shot (free-limit release, finalize) must use the NULL-safe rule",
    );
    ok(
      rpc.includes("get diagnostics v_consumed = row_count") &&
        rpc.includes("if v_consumed <> 1 then"),
      "apply_synced_shot must assert the finalize UPDATE consumed exactly the one named permit",
    );
    ok(
      /when sqlstate 'pkp01' then\s+(--[^\n]*\s+)*return 'access\.permit_not_reserved';/.test(
        rpc,
      ) && /when sqlstate 'pkp02' then\s+return 'access\.paywall_required';/.test(rpc),
      "a shots-gate refusal inside the RPC must surface as its contract verdict by SQLSTATE alone, never shot.write_failed:42501",
    );

    const [gate] = functionBodies(raw, "enforce_scored_shot_permit");
    ok(gate, `${PERMIT_LIFECYCLE} must recreate public.enforce_scored_shot_permit`);
    ok(
      gate.includes("if v_vouched is not null then") &&
        gate.includes("p.id = v_vouched") &&
        gate.includes("and public.permit_backs_sync(p.status, p.outcome)") &&
        !gate.includes("outcome = 'expired'"),
      "with a vouch the gate must decide on the vouched permit through permit_backs_sync",
    );
    ok(
      !/\)\s*and not exists\s*\(/.test(gate),
      "the gate must not OR the vouched permit with any other live reservation (no fallback)",
    );
    ok(
      /errcode = 'pkp01',\s+message = [^\n]*\n\s+hint = 'access\.permit_not_reserved'/.test(gate) &&
        gate.includes(
          "errcode = case when v_vouched is not null then 'pkp02' else 'insufficient_privilege' end",
        ) &&
        /errcode = 'insufficient_privilege',\s+message = [^\n]*\n\s+hint = 'access\.permit_not_reserved'/.test(
          gate,
        ),
      "vouched refusals must raise the verdict SQLSTATEs (PKP01 permit / PKP02 allowance); direct-INSERT refusals stay 42501",
    );

    // The lifecycle guard: every role, INSERT and UPDATE, non-executable by clients.
    const [guard] = functionBodies(raw, "guard_analysis_permit_lifecycle");
    ok(guard, `${PERMIT_LIFECYCLE} must define public.guard_analysis_permit_lifecycle`);
    ok(
      guard.includes("(new.status = 'reserved') <> (new.outcome is null)") &&
        guard.includes("errcode = 'check_violation'") &&
        guard.includes("hint = 'access.permit_transition_rejected'"),
      "the guard must pin released ⇒ outcome IS NOT NULL and answer 23514 + the contract hint",
    );
    ok(
      guard.includes("if old.status = 'reserved' then") &&
        guard.includes("if old.status = 'released' and old.outcome = 'expired'") &&
        guard.includes("('finalized', 'scored')") &&
        guard.includes("('released', 'low_confidence')") &&
        guard.includes("('released', 'free_limit_exceeded')"),
      "the guard must allow exactly reserved → settled and released/expired → the late-sync outcomes",
    );
    ok(
      migration.statements.includes(
        "create trigger analysis_permits_guard_lifecycle before insert or update on public.analysis_permits for each row execute function public.guard_analysis_permit_lifecycle()",
      ),
      "the guard must be a BEFORE INSERT OR UPDATE row trigger on public.analysis_permits",
    );
    ok(
      migration.statements.includes(
        "revoke execute on function public.guard_analysis_permit_lifecycle() from public, anon, authenticated",
      ) &&
        migration.statements.includes(
          "revoke execute on function public.enforce_scored_shot_permit() from public, anon, authenticated",
        ),
      "trigger functions must stay non-executable by clients",
    );

    // Later migrations must keep the guard and never spell the backing rule
    // inline again.
    for (const later of after(chain, PERMIT_LIFECYCLE)) {
      ok(
        !dropsTriggerWithoutRecreating(later, "analysis_permits_guard_lifecycle"),
        `${later.file} drops analysis_permits_guard_lifecycle without recreating it`,
      );
      const body = stripSqlComments(later.raw);
      for (const fn of ["apply_synced_shot", "enforce_scored_shot_permit"]) {
        for (const def of functionBodies(body, fn)) {
          ok(
            def.includes("public.permit_backs_sync(") && !def.includes("outcome = 'expired'"),
            `${later.file}: ${fn} must decide permit backing through permit_backs_sync()`,
          );
        }
      }
    }
  },
);

// ─── ADV7-PERMIT-REUSE-DELETE-REINSERT: settled permits are terminal for the
// client role; one-permit-one-shot is a data-layer invariant ─────────────────

function grantsOnPermits(statement: string, privilege: string): boolean {
  if (!statement.startsWith("grant ")) return false;
  const [privileges, objects = ""] = statement.split(" on ", 2);
  if (!new RegExp(`\\b${privilege}\\b`).test(privileges) && !/\ball\b/.test(privileges)) {
    return false;
  }
  return /\bpublic\.analysis_permits\b/.test(objects);
}

function createsPolicyOnPermits(statement: string, command: string): boolean {
  return (
    statement.startsWith("create policy") &&
    /\bon public\.analysis_permits\b/.test(statement) &&
    new RegExp(`\\bfor (${command}|all)\\b`).test(statement)
  );
}

Deno.test(
  "permits: the client cannot DELETE a permit or name its id/timestamps, a consumed permit id can never be re-created, and every shot records the one permit it consumed",
  async () => {
    const chain = await loadChain();
    const migration = chain.find((m) => m.file === PERMIT_TERMINAL);
    ok(migration, `${PERMIT_TERMINAL} must exist in the migration chain`);
    ok(
      PERMIT_TERMINAL > PERMIT_LIFECYCLE,
      "the terminality migration must follow the lifecycle migration",
    );
    const { statements } = migration;
    const raw = stripSqlComments(migration.raw);

    // 1. No client DELETE, ever again.
    ok(
      statements.includes(
        'drop policy if exists "analysis_permits_delete_own" on public.analysis_permits',
      ) &&
        statements.includes(
          "revoke delete on public.analysis_permits from public, anon, authenticated",
        ),
      "the owner DELETE policy must be dropped and the DELETE grant revoked from every client role",
    );

    // 2. Client INSERT sized to the product shape: id / created_at / updated_at
    //    are server-assigned. The reservation RPC is SECURITY INVOKER, so the
    //    column grant (not a revoke) is the closure.
    ok(
      statements.includes(
        "revoke insert on public.analysis_permits from public, anon, authenticated",
      ) &&
        statements.includes(
          "grant insert (user_id, idempotency_key, status, outcome) on public.analysis_permits to authenticated",
        ),
      "the table-level INSERT grant must be replaced by a column grant without id/created_at/updated_at",
    );
    const reserveDefs = chain.flatMap((m) =>
      functionBodies(stripSqlComments(m.raw), "reserve_analysis_permit"),
    );
    ok(reserveDefs.length > 0, "reserve_analysis_permit must be defined in the chain");
    for (const def of reserveDefs) {
      ok(
        !/security definer/.test(def) &&
          /insert into public\.analysis_permits \(user_id, idempotency_key\)/.test(def),
        "reserve_analysis_permit stays SECURITY INVOKER and inserts exactly (user_id, idempotency_key) — the column grant must keep covering it",
      );
    }

    // 3. The durable link + one-permit-one-shot index.
    ok(
      statements.includes(
        "alter table public.shots add column if not exists analysis_permit_id uuid",
      ) &&
        statements.includes(
          "create unique index if not exists shots_analysis_permit_unique on public.shots (analysis_permit_id) where analysis_permit_id is not null",
        ),
      "shots.analysis_permit_id must exist with a partial UNIQUE index (NULL rows — premium/no-permit/pre-fix — stay free)",
    );

    // 4. Resurrection guard: definer BEFORE INSERT, refuses an id already on a
    //    shot with the lifecycle SQLSTATE/hint, non-executable by clients.
    const [guard] = functionBodies(raw, "guard_analysis_permit_resurrection");
    ok(guard, `${PERMIT_TERMINAL} must define public.guard_analysis_permit_resurrection`);
    ok(
      /security definer/.test(guard) &&
        guard.includes("where s.analysis_permit_id = new.id") &&
        guard.includes("errcode = 'check_violation'") &&
        guard.includes("hint = 'access.permit_transition_rejected'"),
      "the resurrection guard must be SECURITY DEFINER and answer 23514 + access.permit_transition_rejected for a consumed id",
    );
    ok(
      statements.includes(
        "create trigger analysis_permits_guard_resurrection before insert on public.analysis_permits for each row execute function public.guard_analysis_permit_resurrection()",
      ) &&
        statements.includes(
          "revoke execute on function public.guard_analysis_permit_resurrection() from public, anon, authenticated",
        ),
      "the resurrection guard must be a BEFORE INSERT row trigger, revoked from clients",
    );

    // 5. The RPC records the link and refuses a permit that already backs a
    //    shot; the gate lets only the vouched permit into the column.
    const [rpc] = functionBodies(raw, "apply_synced_shot");
    ok(rpc, `${PERMIT_TERMINAL} must recreate public.apply_synced_shot`);
    ok(
      rpc.includes("where s.analysis_permit_id = v_permit_id") &&
        rpc.includes("return 'access.permit_not_reserved'") &&
        /insert into public\.shots \([^)]*\banalysis_permit_id\b/.test(rpc) &&
        /when unique_violation then[\s\S]*?analysis_permit_id = v_permit_id[\s\S]*?return 'access\.permit_not_reserved'/.test(
          rpc,
        ),
      "apply_synced_shot must refuse a permit id already recorded on a shot, write the link, and map the index race to access.permit_not_reserved",
    );
    const [gate] = functionBodies(raw, "enforce_scored_shot_permit");
    ok(gate, `${PERMIT_TERMINAL} must recreate public.enforce_scored_shot_permit`);
    ok(
      gate.includes(
        "if new.analysis_permit_id is not null\n     and (v_vouched is null or new.analysis_permit_id <> v_vouched) then",
      ) && gate.includes("new.analysis_permit_id := v_vouched"),
      "the gate must refuse a client-written analysis_permit_id (42501) and always write the vouched permit",
    );

    // Later migrations must not reopen any of it.
    for (const later of after(chain, PERMIT_TERMINAL)) {
      for (const statement of later.statements) {
        ok(
          !grantsOnPermits(statement, "delete"),
          `${later.file} re-grants DELETE on public.analysis_permits: ${statement}`,
        );
        ok(
          !createsPolicyOnPermits(statement, "delete"),
          `${later.file} recreates a DELETE policy on public.analysis_permits: ${statement}`,
        );
        ok(
          !(grantsOnPermits(statement, "insert") && !/^grant insert \([^)]*\)/.test(statement)) &&
            !/^grant insert \([^)]*\b(id|created_at|updated_at)\b/.test(statement),
          `${later.file} widens the client INSERT on public.analysis_permits: ${statement}`,
        );
        ok(
          !/^drop index .*shots_analysis_permit_unique/.test(statement),
          `${later.file} drops shots_analysis_permit_unique`,
        );
      }
      ok(
        !dropsTriggerWithoutRecreating(later, "analysis_permits_guard_resurrection"),
        `${later.file} drops analysis_permits_guard_resurrection without recreating it`,
      );
    }
  },
);

// ─── ADV-11-PREFIX-RESURRECTION + ADV-17-SETTLED-UNRESTORABLE (round 9):
// settled permits are terminal for the OWNER role across DELETE ──────────────

function grantsOnTombstones(statement: string): boolean {
  return (
    statement.startsWith("grant ") &&
    /\bpublic\.analysis_permit_tombstones\b/.test(statement.split(" on ", 2)[1] ?? "")
  );
}

Deno.test(
  "permits: an owner-role DELETE of a settled or shot-linked permit leaves a tombstone the id can only be restored into (BEFORE DELETE definer guard, revoked from clients, never dropped later); the account cascade is exempt; the lifecycle guard stays",
  async () => {
    const chain = await loadChain();
    const migration = chain.find((m) => m.file === PERMIT_SETTLED_NO_DELETE);
    ok(migration, `${PERMIT_SETTLED_NO_DELETE} must exist in the migration chain`);
    ok(
      PERMIT_SETTLED_NO_DELETE > PERMIT_TERMINAL,
      "the owner-role terminality migration must follow the client-role one",
    );
    const { statements } = migration;
    const raw = stripSqlComments(migration.raw);

    // 1. The tombstone table is service-only: RLS on, every client grant
    //    revoked, no policy, cascades away with the profile.
    ok(
      statements.some((s) =>
        /^create table if not exists public\.analysis_permit_tombstones \( permit_id uuid primary key, user_id uuid not null references public\.profiles \(id\) on delete cascade,/.test(
          s,
        ),
      ) &&
        statements.includes(
          "alter table public.analysis_permit_tombstones enable row level security",
        ) &&
        statements.includes(
          "revoke all on public.analysis_permit_tombstones from public, anon, authenticated",
        ) &&
        !statements.some((s) =>
          /^create policy .* on public\.analysis_permit_tombstones\b/.test(s),
        ),
      "analysis_permit_tombstones must be keyed by permit id, cascade from profiles, have RLS on, no client grants and no policies",
    );

    // 2. BEFORE DELETE guard: definer, pinned search_path, exempts the account
    //    cascade (profile already gone) and reserved+unlinked rows, remembers
    //    everything else, revoked from clients.
    const [del] = functionBodies(raw, "guard_analysis_permit_delete");
    ok(del, `${PERMIT_SETTLED_NO_DELETE} must define public.guard_analysis_permit_delete`);
    ok(
      /security definer/.test(del) &&
        /set search_path = pg_catalog, public/.test(del) &&
        del.includes(
          "if not exists (select 1 from public.profiles p where p.id = old.user_id) then\n    return old;",
        ) &&
        del.includes("if old.status = 'reserved'") &&
        del.includes(
          "not exists (select 1 from public.shots s where s.analysis_permit_id = old.id) then\n    return old;",
        ) &&
        del.includes("insert into public.analysis_permit_tombstones") &&
        del.includes(
          "(old.id, old.user_id, old.idempotency_key, old.status, old.outcome, old.created_at, now())",
        ) &&
        !/raise exception/.test(del),
      "the delete guard must be SECURITY DEFINER with search_path = pg_catalog, public; let the account cascade and reserved/unlinked rows through; and tombstone every settled or linked permit",
    );
    ok(
      statements.includes(
        "create trigger analysis_permits_guard_delete before delete on public.analysis_permits for each row execute function public.guard_analysis_permit_delete()",
      ) &&
        statements.includes(
          "revoke execute on function public.guard_analysis_permit_delete() from public, anon, authenticated",
        ),
      "the delete guard must be a BEFORE DELETE row trigger on public.analysis_permits, revoked from clients",
    );

    // 3. Resurrection guard, same trigger: a tombstoned id is re-creatable only
    //    as the identical settled row (consuming the tombstone); every other
    //    shape, and an id on a shot without a tombstone, is 23514.
    const [res] = functionBodies(raw, "guard_analysis_permit_resurrection");
    ok(res, `${PERMIT_SETTLED_NO_DELETE} must redefine public.guard_analysis_permit_resurrection`);
    ok(
      /security definer/.test(res) &&
        res.includes(
          "from public.analysis_permit_tombstones x\n  where x.permit_id = new.id\n  for update",
        ) &&
        res.includes(
          "if new.user_id = t.user_id\n       and new.idempotency_key = t.idempotency_key\n       and new.status = t.status\n       and new.outcome is not distinct from t.outcome then",
        ) &&
        res.includes(
          "delete from public.analysis_permit_tombstones x where x.permit_id = new.id;\n      return new;",
        ) &&
        res.includes("where s.analysis_permit_id = new.id") &&
        (res.match(/errcode = 'check_violation'/g) ?? []).length === 2 &&
        (res.match(/hint = 'access\.permit_transition_rejected'/g) ?? []).length === 2,
      "the resurrection guard must allow exactly the identical restore of a tombstoned id and answer 23514 + access.permit_transition_rejected to every other re-creation",
    );
    ok(
      statements.includes(
        "revoke execute on function public.guard_analysis_permit_resurrection() from public, anon, authenticated",
      ) && !dropsTriggerWithoutRecreating(migration, "analysis_permits_guard_resurrection"),
      "the redefined resurrection guard stays non-executable by clients and keeps its trigger",
    );

    // 4. The RPC answers permit_not_reserved for the caller's tombstoned id
    //    through the auth.uid()-scoped definer reader.
    const [reader] = functionBodies(raw, "permit_tombstoned");
    ok(reader, `${PERMIT_SETTLED_NO_DELETE} must define public.permit_tombstoned`);
    ok(
      /security definer/.test(reader) &&
        reader.includes("and t.user_id = (select auth.uid())") &&
        statements.includes(
          "revoke all on function public.permit_tombstoned(uuid) from public, anon",
        ) &&
        statements.includes(
          "grant execute on function public.permit_tombstoned(uuid) to authenticated",
        ),
      "permit_tombstoned() must be a definer reader scoped to auth.uid(), executable by authenticated only",
    );
    const [rpc] = functionBodies(raw, "apply_synced_shot");
    ok(rpc, `${PERMIT_SETTLED_NO_DELETE} must recreate public.apply_synced_shot`);
    ok(
      /if not found then\s+if public\.permit_tombstoned\(v_permit_id\) then\s+return 'access\.permit_not_reserved';\s+end if;\s+return 'access\.permit_not_found';/.test(
        rpc,
      ) &&
        rpc.includes("where s.analysis_permit_id = v_permit_id") &&
        rpc.includes("public.permit_backs_sync(") &&
        rpc.includes("public.lifetime_scored_count() >= 2"),
      "apply_synced_shot must answer access.permit_not_reserved for a tombstoned own permit and keep the round-8 link / backing / lifetime-count rules",
    );

    // 5. No FK with SET NULL on the link (it recreates the ADV-11 blind spot).
    for (const m of chain) {
      for (const s of m.statements) {
        ok(
          !(/\banalysis_permit_id\b/.test(s) && /\bon delete set null\b/.test(s)),
          `${m.file}: shots.analysis_permit_id must never be ON DELETE SET NULL: ${s}`,
        );
      }
    }

    // 6. Later migrations keep every guard and never open the tombstones.
    for (const later of after(chain, PERMIT_SETTLED_NO_DELETE)) {
      for (const statement of later.statements) {
        ok(
          !grantsOnTombstones(statement),
          `${later.file} grants on public.analysis_permit_tombstones: ${statement}`,
        );
        ok(
          !/^create policy .* on public\.analysis_permit_tombstones\b/.test(statement) &&
            !/^drop table .*analysis_permit_tombstones/.test(statement) &&
            !/^alter table public\.analysis_permit_tombstones disable row level security/.test(
              statement,
            ),
          `${later.file} opens public.analysis_permit_tombstones: ${statement}`,
        );
        ok(
          !/^alter table public\.analysis_permits disable trigger/.test(statement),
          `${later.file} disables a trigger on public.analysis_permits: ${statement}`,
        );
      }
      for (const trigger of [
        "analysis_permits_guard_delete",
        "analysis_permits_guard_resurrection",
        "analysis_permits_guard_lifecycle",
      ]) {
        ok(
          !dropsTriggerWithoutRecreating(later, trigger),
          `${later.file} drops ${trigger} without recreating it`,
        );
      }
    }
    // The lifecycle guard is what makes UPDATE terminal for the owner role too;
    // it must still be the BEFORE INSERT OR UPDATE trigger 20260906140000
    // installed, in every migration that (re)creates it.
    for (const m of chain) {
      for (const s of m.statements) {
        if (s.startsWith("create trigger analysis_permits_guard_lifecycle ")) {
          ok(
            s ===
              "create trigger analysis_permits_guard_lifecycle before insert or update on public.analysis_permits for each row execute function public.guard_analysis_permit_lifecycle()",
            `${m.file}: analysis_permits_guard_lifecycle must stay a BEFORE INSERT OR UPDATE row trigger: ${s}`,
          );
        }
      }
    }
  },
);

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

Deno.test(
  "user database RPCs never switch to SECURITY DEFINER and bypass the API gate",
  async () => {
    const chain = await loadChain();
    const invokers = [
      "access_lock_key",
      "access_state",
      "apply_synced_shot",
      "complete_onboarding",
      "is_api_session_active",
      "lifetime_scored_count",
      "reserve_analysis_permit",
    ];
    for (const name of invokers) {
      let definitions = 0;
      for (const migration of chain) {
        for (const body of functionBodies(migration.raw, name)) {
          definitions += 1;
          const header = body.slice(0, body.indexOf("$$"));
          ok(
            !/security\s+definer/.test(header),
            `${migration.file}: public.${name} must execute under the user's RLS`,
          );
        }
        for (const statement of migration.statements) {
          ok(
            !(
              statement.startsWith(`alter function public.${name}(`) &&
              statement.includes("security definer")
            ),
            `${migration.file}: public.${name} must not be promoted to SECURITY DEFINER`,
          );
        }
      }
      ok(definitions > 0, `public.${name} must exist`);
    }
  },
);

Deno.test(
  "combined audit: definer readers retain API proof and owner scoping after the last migration",
  async () => {
    const chain = await loadChain();
    const integration = chain.find((m) => m.file === "20260907110000_api_audit_integration.sql");
    ok(integration, "the combined audit requires a new forward migration");
    ok(
      integration.file > PERMIT_SETTLED_NO_DELETE,
      "the integration migration must follow the upstream chain",
    );
    for (const name of ["identity_scored_count", "permit_tombstoned"]) {
      const latest = chain.flatMap((m) => functionBodies(m.raw, name)).at(-1);
      ok(latest, `public.${name} must exist`);
      ok(latest.includes("security definer"), `public.${name} is a narrowly scoped ledger reader`);
      ok(
        latest.includes("api_private.is_api_request()"),
        `public.${name} must require the API proof`,
      );
      ok(
        latest.includes("(select auth.uid())"),
        `public.${name} must scope its read to the caller`,
      );
      ok(latest.includes("set search_path = ''"), `public.${name} must pin its search_path`);
    }
    for (const column of ["id", "user_id", "idempotency_key", "created_at"]) {
      ok(
        integration.raw.includes(`new.${column} is distinct from old.${column}`),
        `permit ${column} must stay immutable`,
      );
    }
    for (const outcome of ["scored", "low_confidence", "free_limit_exceeded"]) {
      ok(integration.raw.includes(`'${outcome}'`), `late sync must retain ${outcome} settlement`);
    }
  },
);

// ─── W01-01: an honest PARTIAL terminal outcome — released, never charged ────

/** Every `create or replace function api_private.<name>(` … `$$;` body. */
function privateFunctionBodies(raw: string, name: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(
    `create(?: or replace)? function api_private\\.${name}\\s*\\([\\s\\S]*?\\$\\$;`,
    "gi",
  );
  for (const match of raw.matchAll(re)) bodies.push(match[0].toLowerCase());
  return bodies;
}

const PERMIT_OUTCOMES_BEFORE_PARTIAL = [
  "scored",
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
  "expired",
  "free_limit_exceeded",
] as const;

/** The free-rating accounting path. A partial outcome is admitted beside it,
 * never by rewriting it: none of these may be redefined by the partial
 * migration, and the latest definition of each keeps its scored-only rule. */
const COUNTING_PATH_FUNCTIONS = [
  "lifetime_scored_count",
  "identity_scored_count",
  "record_scored_shot_in_ledger",
  "permit_backs_sync",
  "apply_synced_shot",
  "enforce_scored_shot_permit",
  "reserve_analysis_permit",
  "access_state",
] as const;

Deno.test(
  "W01-01: partial is an explicit released terminal outcome for permits and shots, admitted beside the counting path without touching it",
  async () => {
    const chain = await loadChain();
    const migration = chain.find((m) => m.file === PERMIT_PARTIAL_OUTCOME);
    ok(migration, `${PERMIT_PARTIAL_OUTCOME} must exist in the migration chain`);
    ok(
      migration.file > ANALYSIS_RELEASE_AUTHORITY,
      "the partial outcome is a forward migration after the release-authority migration",
    );
    const raw = stripSqlComments(migration.raw);

    // The lifecycle guard learns exactly one new word and one new shape rule.
    const [guard] = functionBodies(raw, "guard_analysis_permit_lifecycle");
    ok(guard, `${PERMIT_PARTIAL_OUTCOME} must redefine public.guard_analysis_permit_lifecycle`);
    for (const outcome of PERMIT_OUTCOMES_BEFORE_PARTIAL) {
      ok(guard.includes(`'${outcome}'`), `the guard must keep the ${outcome} outcome`);
    }
    ok(
      /new\.outcome not in \(\s*'scored', 'low_confidence', 'partial',/.test(guard),
      "the guard vocabulary must admit 'partial' as its own outcome (never relabelled as low_confidence)",
    );
    ok(
      guard.includes("(new.status = 'reserved') <> (new.outcome is null)") &&
        guard.includes("errcode = 'check_violation'") &&
        guard.includes("hint = 'access.permit_transition_rejected'"),
      "the guard must keep released ⇒ outcome IS NOT NULL and answer 23514 + the contract hint",
    );
    ok(
      guard.includes("(new.outcome = 'partial' and new.status <> 'released')"),
      "a partial outcome must only ever be released — finalized/partial is not a permit state",
    );
    ok(
      guard.includes("if old.status = 'reserved' then") &&
        guard.includes("if old.status = 'released' and old.outcome = 'expired'") &&
        guard.includes("('finalized', 'scored')") &&
        guard.includes("('released', 'low_confidence')") &&
        guard.includes("('released', 'free_limit_exceeded')") &&
        guard.includes("('released', 'partial')"),
      "the guard must allow reserved → settled and released/expired → the late-sync outcomes including released/partial",
    );
    ok(
      migration.statements.includes(
        "revoke execute on function public.guard_analysis_permit_lifecycle() from public, anon, authenticated",
      ),
      "the redefined guard must stay non-executable by clients",
    );
    ok(
      !dropsTriggerWithoutRecreating(migration, "analysis_permits_guard_lifecycle"),
      "the lifecycle trigger must survive the redefinition",
    );

    // The API-plane transition guard admits the same late transition.
    const [transition] = privateFunctionBodies(raw, "enforce_permit_transition");
    ok(transition, `${PERMIT_PARTIAL_OUTCOME} must redefine api_private.enforce_permit_transition`);
    for (const column of ["id", "user_id", "idempotency_key", "created_at"]) {
      ok(
        transition.includes(`new.${column} is distinct from old.${column}`),
        `permit ${column} must stay immutable`,
      );
    }
    ok(
      transition.includes(
        "(old.status = 'reserved' and new.status in ('finalized', 'released'))",
      ) &&
        transition.includes("('finalized', 'scored')") &&
        transition.includes("('released', 'low_confidence')") &&
        transition.includes("('released', 'free_limit_exceeded')") &&
        transition.includes("('released', 'partial')"),
      "enforce_permit_transition must keep every prior transition and add released/expired → released/partial",
    );
    ok(
      migration.statements.includes(
        "revoke all on function api_private.enforce_permit_transition() from public, anon, authenticated, service_role",
      ),
      "the redefined transition guard must stay non-executable",
    );

    // shots.result_kind admits 'partial'; the unscored invariant is untouched.
    ok(
      migration.statements.includes(
        "alter table public.shots drop constraint shots_result_kind_check",
      ) &&
        migration.statements.includes(
          "alter table public.shots add constraint shots_result_kind_check check (result_kind in ('scored', 'low_confidence', 'partial')) not valid",
        ) &&
        migration.statements.includes(
          "alter table public.shots validate constraint shots_result_kind_check",
        ),
      "shots.result_kind must be widened to exactly scored | low_confidence | partial (NOT VALID + VALIDATE — no exclusive-lock rescan)",
    );
    ok(
      !migration.statements.some(
        (s) =>
          s.startsWith("alter table public.shots") && s.includes("shots_low_confidence_unscored"),
      ),
      "shots_low_confidence_unscored (non-scored ⇒ overall_score IS NULL) is what keeps a partial unscored — it must not be touched",
    );

    // The counting path is not rewritten, and its latest definitions still
    // count scored rows only.
    for (const name of COUNTING_PATH_FUNCTIONS) {
      ok(
        functionBodies(raw, name).length === 0,
        `${PERMIT_PARTIAL_OUTCOME} must not redefine public.${name}`,
      );
    }
    const backing = chain.flatMap((m) => functionBodies(m.raw, "permit_backs_sync")).at(-1);
    ok(backing && NULL_SAFE_BACKING_RULE.test(backing), "released/partial is never permit backing");
    const ledger = chain
      .flatMap((m) => functionBodies(stripSqlComments(m.raw), "record_scored_shot_in_ledger"))
      .at(-1);
    ok(
      ledger && ledger.includes("if new.result_kind <> 'scored'"),
      "the identity ledger must record scored shots only",
    );
    const lifetime = chain
      .flatMap((m) => functionBodies(stripSqlComments(m.raw), "lifetime_scored_count"))
      .at(-1);
    ok(
      lifetime && lifetime.includes("s.result_kind = 'scored'"),
      "lifetime_scored_count must count scored shots only",
    );

    // No grant or policy surface changes ride along.
    for (const statement of migration.statements) {
      ok(
        !statement.startsWith("grant ") &&
          !/^(create|alter|drop) policy\b/.test(statement) &&
          !statement.includes("disable row level security"),
        `${PERMIT_PARTIAL_OUTCOME} must not change grants or policies: ${statement}`,
      );
    }
  },
);

// ─── W04-01: device registry, offline grants, append-only allocation ledger ──

const OFFLINE_TABLES = ["offline_devices", "offline_grants", "offline_allocation_ledger"] as const;

/** Every `public.<name>` user RPC the offline routes call: session-bound
 * definers that never read or write outside the caller's own rows. */
const OFFLINE_MUTATING_RPCS = [
  "register_offline_device",
  "issue_offline_grant",
  "consume_offline_ticket",
  "release_offline_ticket",
] as const;

/** The one ownership test every ticket path shares: the allocation's account
 * OR any current sign-in identity of the caller that the allocation was made
 * under — so the original installation of a deleted-and-recreated account can
 * still recover, consume and release its ticket, and nobody else can. */
const OFFLINE_OWNER_PREDICATE = "api_private.offline_ticket_owned_by(";

/** `functionBodies` for `api_private.<name>` definers. */
function apiPrivateFunctionBodies(raw: string, name: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(
    `create(?: or replace)? function api_private\\.${name}\\s*\\([\\s\\S]*?\\$\\$;`,
    "gi",
  );
  for (const match of raw.matchAll(re)) bodies.push(match[0].toLowerCase());
  return bodies;
}

Deno.test(
  "W04-01: device registry, per-device offline grants with bounded expiry, and an append-only allocation ledger where allocation ≠ consumption, all API-only and never auto-reclaimed",
  async () => {
    const chain = await loadChain();
    const migration = chain.find((m) => m.file === OFFLINE_DEVICE_GRANTS);
    ok(migration, `${OFFLINE_DEVICE_GRANTS} must exist in the migration chain`);
    ok(
      migration.file > PERMIT_PARTIAL_OUTCOME,
      "the offline grants migration follows the partial-outcome migration",
    );
    const raw = stripSqlComments(migration.raw);
    const statements = migration.statements;

    // Three new tables, every one RLS-enabled, owner-scoped, API-gated, and
    // readable only — the client role never writes them directly.
    for (const table of OFFLINE_TABLES) {
      ok(
        statements.some((s) => s.startsWith(`create table if not exists public.${table} (`)),
        `${OFFLINE_DEVICE_GRANTS} must create public.${table}`,
      );
      ok(
        statements.includes(`alter table public.${table} enable row level security`),
        `public.${table} must enable RLS`,
      );
      ok(
        statements.includes(
          `revoke all on public.${table} from public, anon, authenticated, service_role`,
        ),
        `public.${table} must drop every default client AND service grant (TRUNCATE fires no row trigger)`,
      );
      ok(
        statements.includes(`grant select on public.${table} to authenticated`),
        `public.${table} is readable by its owner through the API`,
      );
      ok(
        statements.some(
          (s) =>
            s.startsWith(
              `create policy ${table}_select_own on public.${table} for select to authenticated using (`,
            ) && s.includes("user_id = (select auth.uid())"),
        ),
        `public.${table} reads are owner-scoped`,
      );
      ok(
        statements.includes(
          `create policy api_requests_only on public.${table} as restrictive for all to authenticated using ((select api_private.is_api_request())) with check ((select api_private.is_api_request()))`,
        ),
        `public.${table} must carry the restrictive API-only policy`,
      );
      for (const statement of statements) {
        ok(
          !(
            statement.startsWith("grant ") &&
            new RegExp(`\\bpublic\\.${table}\\b`).test(statement) &&
            /\b(insert|update|delete|truncate|references|trigger|all)\b/.test(
              statement.split(" on ")[0],
            ) &&
            /\b(anon|authenticated|public|service_role)\b/.test(statement.split(" to ").pop() ?? "")
          ),
          `public.${table} must never be writable or truncatable outside the RPCs: ${statement}`,
        );
        ok(
          !(
            /^create policy\b/.test(statement) &&
            statement.includes(`on public.${table}`) &&
            /\bfor (insert|update|delete)\b/.test(statement)
          ),
          `public.${table} must carry no client write policy: ${statement}`,
        );
      }
    }

    // Device registry: one row per (owner, installation key); attestation is
    // an explicit state, never inferred from a nullable timestamp alone.
    ok(
      raw.includes("unique (user_id, installation_key_id)"),
      "a device is keyed by owner + installation key",
    );
    ok(
      raw.includes("attestation_environment in ('production', 'development')") &&
        raw.includes("attestation_state in ('attested', 'unattested')") &&
        raw.includes("(attestation_state = 'attested') = (attested_at is not null)"),
      "device attestation is an explicit environment + state pair",
    );

    // Grants: the lease is bounded at the table — never longer than 7 days,
    // never past the verified entitlement expiry, never mutated after issue.
    ok(
      raw.includes("entitlement_source in ('identity_lifetime_free', 'verified_store')"),
      "a grant names its entitlement source",
    );
    ok(
      /constraint offline_grants_bounded_lease\s+check \(expires_at > issued_at and expires_at <= issued_at \+ interval '7 days'\)/.test(
        raw,
      ),
      "a grant never outlives issued_at + 7 days",
    );
    ok(
      /constraint offline_grants_within_entitlement\s+check \(entitlement_expires_at is null or expires_at <= entitlement_expires_at\)/.test(
        raw,
      ),
      "a grant never outlives the verified entitlement",
    );
    ok(raw.includes("unique (device_id, generation)"), "grant generations are unique per device");
    const [grantGuard] = functionBodies(raw, "guard_offline_grant");
    ok(grantGuard, `${OFFLINE_DEVICE_GRANTS} must define public.guard_offline_grant`);
    ok(
      grantGuard.includes("security definer") && grantGuard.includes("set search_path = ''"),
      "the grant guard is a pinned definer (it reads billing_entitlements and the device)",
    );
    ok(
      grantGuard.includes("tg_op = 'update'") &&
        grantGuard.includes("b.premium and (b.expires_at is null or b.expires_at > now())") &&
        grantGuard.includes("new.entitlement_expires_at is distinct from") &&
        grantGuard.includes("d.attestation_state = 'attested'") &&
        grantGuard.includes("errcode = 'check_violation'"),
      "the grant guard refuses mutation, unverified/stale Pro leases, a mis-recorded entitlement expiry and unattested devices",
    );
    ok(
      statements.includes(
        "create trigger offline_grants_guard before insert or update on public.offline_grants for each row execute function public.guard_offline_grant()",
      ),
      "every grant write passes the guard",
    );

    // Ledger: append-only for every role, one event per (ticket, kind),
    // consumption names exactly one delivered scored shot, release names a
    // reason; no FK to the account so deletion never erases accounting.
    ok(
      raw.includes("event in ('allocated', 'consumed', 'released')") &&
        raw.includes("(event = 'consumed') = (shot_id is not null)") &&
        raw.includes("(event = 'released') = (reason is not null)") &&
        raw.includes("unique (ticket_id, event)"),
      "the ledger vocabulary is allocated | consumed | released with shape rules",
    );
    ok(
      /create table if not exists public\.offline_allocation_ledger \([\s\S]*?installation_key_id text not null[\s\S]*?\n\);/.test(
        raw,
      ) &&
        /constraint offline_allocation_ledger_installation_key_bounds\s+check \(installation_key_id ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,127\}\$'\)/.test(
          raw,
        ),
      "every ledger row names the installation that holds the ticket, so recovery does not depend on the (cascading) device row",
    );
    ok(
      statements.some((s) =>
        /^create unique index if not exists offline_allocation_ledger_shot_idx on public\.offline_allocation_ledger \(shot_id\) where shot_id is not null$/.test(
          s,
        ),
      ),
      "a delivered shot consumes at most one ticket",
    );
    ok(
      statements.some((s) =>
        s.startsWith(
          "create index if not exists offline_allocation_ledger_user_event_idx on public.offline_allocation_ledger (user_id, event",
        ),
      ) &&
        statements.some((s) =>
          s.startsWith(
            "create index if not exists offline_allocation_ledger_ticket_idx on public.offline_allocation_ledger (ticket_id",
          ),
        ) &&
        statements.some((s) =>
          s.startsWith(
            "create index if not exists offline_allocation_ledger_identity_idx on public.offline_allocation_ledger using gin (identity_hashes)",
          ),
        ),
      "the ledger is indexed for owner, ticket and identity lookups",
    );
    const ledgerTable = raw.slice(
      raw.search(/create table if not exists public\.offline_allocation_ledger \(/),
    );
    const ledgerBody = ledgerTable.slice(0, ledgerTable.search(/\n\);/));
    ok(
      !/\breferences\b/.test(ledgerBody),
      "the ledger carries no foreign key — account deletion, device deletion and grant expiry never erase it",
    );
    const [appendOnly] = functionBodies(raw, "guard_offline_ledger_append_only");
    ok(appendOnly, `${OFFLINE_DEVICE_GRANTS} must define public.guard_offline_ledger_append_only`);
    ok(
      appendOnly.includes("raise exception") && appendOnly.includes("errcode = 'check_violation'"),
      "the ledger refuses UPDATE and DELETE for every role",
    );
    ok(
      statements.includes(
        "create trigger offline_allocation_ledger_append_only before update or delete on public.offline_allocation_ledger for each row execute function public.guard_offline_ledger_append_only()",
      ),
      "the append-only guard is wired",
    );
    const [eventGuard] = functionBodies(raw, "guard_offline_ledger_event");
    ok(eventGuard, `${OFFLINE_DEVICE_GRANTS} must define public.guard_offline_ledger_event`);
    ok(
      eventGuard.includes("security definer") && eventGuard.includes("set search_path = ''"),
      "the event guard is a pinned definer",
    );
    ok(
      eventGuard.includes("new.event = 'allocated'") &&
        eventGuard.includes("t.event in ('consumed', 'released')") &&
        eventGuard.includes("s.result_kind = 'scored'") &&
        eventGuard.includes("s.analysis_permit_id is null") &&
        eventGuard.includes("s.user_id = new.user_id") &&
        eventGuard.includes("reason in ('unused_ticket_returned', 'support_review')"),
      "consumption and release require a prior allocation with no terminal event; consumption names a scored, permit-free shot of the same owner; release names an explicit reason",
    );
    ok(
      eventGuard.includes(
        `${OFFLINE_OWNER_PREDICATE}v_allocation.user_id, v_allocation.identity_hashes, new.user_id)`,
      ) &&
        !eventGuard.includes("new.user_id is distinct from v_allocation.user_id") &&
        eventGuard.includes(
          "new.installation_key_id is distinct from v_allocation.installation_key_id",
        ),
      "a terminal event may be written by the allocation's account OR the same sign-in identity (original-owner recovery after account re-creation), never by another owner, and always on the allocation's installation key",
    );
    ok(
      eventGuard.includes("new.installation_key_id := ") &&
        eventGuard.includes("from public.offline_devices d") &&
        eventGuard.includes("d.id = new.device_id"),
      "an allocation inherits its installation key from the registered device it was issued to",
    );

    // The ownership predicate and the identity reader live in api_private,
    // pinned definers no client role can call.
    for (const helper of [
      "offline_identity_hashes(uuid)",
      "offline_ticket_owned_by(uuid, text[], uuid)",
    ]) {
      const [body] = apiPrivateFunctionBodies(raw, helper.split("(")[0]);
      ok(body, `${OFFLINE_DEVICE_GRANTS} must define api_private.${helper}`);
      ok(
        body.includes("security definer") && body.includes("set search_path = ''"),
        `api_private.${helper} is a pinned definer`,
      );
      ok(
        statements.includes(
          `revoke all on function api_private.${helper} from public, anon, authenticated, service_role`,
        ),
        `api_private.${helper} is not executable by any client or service role`,
      );
    }
    const [identityHashes] = apiPrivateFunctionBodies(raw, "offline_identity_hashes");
    ok(
      identityHashes.includes("public.free_rating_identity_hash(i.provider, i.provider_id)") &&
        identityHashes.includes("from auth.identities i"),
      "identities are hashed exactly like the free-rating ledger (sha256 of provider:provider_id)",
    );
    const [ownedBy] = apiPrivateFunctionBodies(raw, "offline_ticket_owned_by");
    ok(
      ownedBy.includes("p_allocation_user_id = p_uid") &&
        ownedBy.includes("p_identity_hashes && api_private.offline_identity_hashes(p_uid)"),
      "ownership = same account OR overlapping sign-in identity",
    );
    ok(
      statements.includes(
        "create trigger offline_allocation_ledger_guard_event before insert on public.offline_allocation_ledger for each row execute function public.guard_offline_ledger_event()",
      ),
      "every ledger append passes the event guard",
    );
    for (const guard of [
      "guard_offline_grant()",
      "guard_offline_ledger_append_only()",
      "guard_offline_ledger_event()",
    ]) {
      ok(
        statements.includes(
          `revoke execute on function public.${guard} from public, anon, authenticated`,
        ),
        `public.${guard} must not be executable by clients`,
      );
    }

    // No automatic reclaim: nothing in the migration schedules or performs a
    // release/delete on the ledger by time, and the grant expiry is the only
    // clock the migration reads for a grant.
    for (const statement of statements) {
      ok(
        !statement.includes("cron.schedule"),
        `${OFFLINE_DEVICE_GRANTS} must not schedule a sweep: ${statement}`,
      );
      ok(
        !/^(update|delete from) public\.offline_allocation_ledger\b/.test(statement),
        `${OFFLINE_DEVICE_GRANTS} must never rewrite the ledger: ${statement}`,
      );
    }
    ok(
      !/expires_at\s*<\s*now\(\)[\s\S]{0,200}(released|delete)/.test(raw) &&
        !/(released|delete)[\s\S]{0,200}expires_at\s*<\s*now\(\)/.test(raw),
      "an expired grant never releases or deletes an allocation",
    );

    // The hold reader: a pinned definer, API-gated, caller-scoped by account
    // AND identity, counting allocated-but-not-consumed tickets (a released
    // ticket stays part of the entitlement).
    const [hold] = functionBodies(raw, "offline_hold_count");
    ok(hold, `${OFFLINE_DEVICE_GRANTS} must define public.offline_hold_count`);
    ok(
      hold.includes("security definer") &&
        hold.includes("set search_path = ''") &&
        hold.includes("api_private.is_api_request()") &&
        hold.includes("(select auth.uid())") &&
        hold.includes("a.event = 'allocated'") &&
        hold.includes("c.event = 'consumed'") &&
        hold.includes("public.free_rating_identity_hash(i.provider, i.provider_id)") &&
        !hold.includes("'released'"),
      "offline_hold_count() counts outstanding + released tickets across the caller's identities behind the API gate",
    );
    ok(
      statements.includes("revoke all on function public.offline_hold_count() from public, anon") &&
        statements.includes(
          "grant execute on function public.offline_hold_count() to authenticated",
        ),
      "offline_hold_count() is granted to authenticated only",
    );

    // Conservation: both online decision points count the offline holds
    // under the same identity-scoped advisory lock, still through
    // lifetime_scored_count().
    for (const name of ["access_state", "reserve_analysis_permit"] as const) {
      const [body] = functionBodies(raw, name);
      ok(body, `${OFFLINE_DEVICE_GRANTS} must redefine public.${name} to count offline holds`);
      ok(
        body.includes("public.lifetime_scored_count()") &&
          body.includes("public.offline_hold_count()"),
        `public.${name} must count lifetime scored + offline holds`,
      );
      ok(
        !/security\s+definer/.test(body.slice(0, body.indexOf("$$"))),
        `public.${name} stays invoker`,
      );
    }
    const [reserve] = functionBodies(raw, "reserve_analysis_permit");
    ok(
      reserve.includes("pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid))"),
      "reserve_analysis_permit keeps the identity-scoped lock",
    );
    ok(
      reserve.includes("if not v_premium and v_remaining <= v_reserved + v_held then"),
      "reserve_analysis_permit refuses when scored + reserved + held exhaust the entitlement",
    );

    // The mutating RPCs: pinned definers bound to a live API session, granted
    // to authenticated, caller-scoped, and every allocation decision runs
    // under the same advisory lock the online path holds.
    for (const name of OFFLINE_MUTATING_RPCS) {
      const [body] = functionBodies(raw, name);
      ok(body, `${OFFLINE_DEVICE_GRANTS} must define public.${name}`);
      ok(
        body.includes("security definer") && body.includes("set search_path = ''"),
        `public.${name} is a pinned definer`,
      );
      ok(
        body.includes("api_private.is_active_session()") &&
          body.includes("errcode = 'insufficient_privilege'"),
        `public.${name} binds to a live API session and fails closed`,
      );
      ok(body.includes("(select auth.uid())"), `public.${name} scopes to the caller`);
      ok(
        statements.some(
          (s) =>
            s.startsWith(`revoke all on function public.${name}(`) &&
            s.endsWith(" from public, anon"),
        ) &&
          statements.some(
            (s) =>
              s.startsWith(`grant execute on function public.${name}(`) &&
              s.endsWith(" to authenticated"),
          ),
        `public.${name} is executable by authenticated only`,
      );
    }
    const [issue] = functionBodies(raw, "issue_offline_grant");
    ok(
      issue.includes("pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid))"),
      "issue_offline_grant allocates under the identity-scoped lock",
    );
    ok(
      issue.includes("public.lifetime_scored_count()") &&
        issue.includes("public.offline_hold_count()") &&
        !/count\(\*\)[^;]*from public\.shots/.test(issue),
      "issue_offline_grant budgets through lifetime_scored_count() + offline holds + live reservations",
    );
    ok(
      issue.includes("interval '7 days'") &&
        issue.includes("least(") &&
        issue.includes("b.premium and (b.expires_at is null or b.expires_at > now())"),
      "a Pro lease is min(issued + 7 days, verified entitlement expiry) and only for an effective entitlement",
    );
    ok(
      issue.includes("'identity_lifetime_free'") && issue.includes("'verified_store'"),
      "issue_offline_grant names both entitlement sources",
    );
    ok(
      issue.includes("'access.paywall_required'"),
      "an exhausted free identity gets the paywall result, never a new ticket",
    );
    // Original-installation recovery: the outstanding tickets a refresh
    // re-issues are looked up by installation key + ownership (account OR
    // identity), not by the device row that account deletion cascades away.
    ok(
      issue.includes("a.installation_key_id = v_device.installation_key_id") &&
        issue.includes(`${OFFLINE_OWNER_PREDICATE}a.user_id, a.identity_hashes, v_uid)`) &&
        !issue.includes("a.device_id = v_device.id"),
      "issue_offline_grant recovers the same installation's outstanding tickets across account re-creation",
    );
    const [consume] = functionBodies(raw, "consume_offline_ticket");
    ok(
      consume.includes("'offline.ticket_consumed'") &&
        consume.includes("'offline.ticket_released'") &&
        consume.includes("'offline.shot_not_chargeable'") &&
        consume.includes("'offline.ticket_not_found'"),
      "consume_offline_ticket answers every terminal state distinctly",
    );
    const [release] = functionBodies(raw, "release_offline_ticket");
    ok(
      release.includes("'offline.ticket_consumed'") &&
        release.includes("'offline.ticket_not_found'"),
      "release_offline_ticket never releases a consumed ticket",
    );
    for (const [name, body] of [
      ["consume_offline_ticket", consume],
      ["release_offline_ticket", release],
    ] as const) {
      ok(
        body.includes(`${OFFLINE_OWNER_PREDICATE}a.user_id, a.identity_hashes, v_uid)`) &&
          !body.includes("a.user_id = v_uid"),
        `public.${name} addresses the caller's tickets by account OR identity`,
      );
    }
    ok(
      release.includes("p_reason <> 'unused_ticket_returned'") &&
        !release.includes("'support_review'"),
      "a client can only return an unused ticket — support_review is an audit reason it never self-asserts",
    );

    // Nothing later reopens any of this.
    for (const later of after(chain, OFFLINE_DEVICE_GRANTS)) {
      for (const trigger of [
        "offline_grants_guard",
        "offline_allocation_ledger_append_only",
        "offline_allocation_ledger_guard_event",
      ]) {
        ok(!dropsTriggerWithoutRecreating(later, trigger), `${later.file} removes ${trigger}`);
      }
      for (const statement of later.statements) {
        for (const table of OFFLINE_TABLES) {
          ok(
            !(
              statement.startsWith("drop table") &&
              new RegExp(`\\bpublic\\.${table}\\b`).test(statement)
            ),
            `${later.file} drops public.${table}`,
          );
          ok(
            !(
              statement.startsWith("grant ") &&
              new RegExp(`\\bpublic\\.${table}\\b`).test(statement) &&
              /\b(insert|update|delete|all)\b/.test(statement.split(" on ")[0]) &&
              /\b(anon|authenticated|public)\b/.test(statement.split(" to ").pop() ?? "")
            ),
            `${later.file} grants client writes on public.${table}: ${statement}`,
          );
        }
      }
    }
  },
);

Deno.test(
  "combined audit: webhook lifecycle grants never permit completed audit mutation",
  async () => {
    const chain = await loadChain();
    const integration = chain.find((m) => m.file === "20260907110000_api_audit_integration.sql");
    ok(integration, "the combined audit requires a new forward migration");
    ok(
      integration.statements.includes(
        "grant update (claimed_at, processed_at), delete on public.webhook_events to service_role",
      ),
      "service-role grants must be limited to reservation lifecycle writes",
    );
    ok(
      integration.raw.includes("if old.processed_at is not null then"),
      "completed audit rows must be immutable",
    );
    ok(
      integration.raw.includes("old.claimed_at > now() - interval '5 minutes'"),
      "a live lease must not be reclaimed",
    );
    ok(
      integration.statements.includes(
        "create trigger webhook_events_guard_lifecycle before update or delete on public.webhook_events for each row execute function api_private.enforce_webhook_lifecycle()",
      ),
      "every webhook mutation must pass the lifecycle guard",
    );
    for (const later of after(chain, integration.file)) {
      ok(
        !dropsTriggerWithoutRecreating(later, "webhook_events_guard_lifecycle"),
        `${later.file} removes audit immutability`,
      );
    }
  },
);
