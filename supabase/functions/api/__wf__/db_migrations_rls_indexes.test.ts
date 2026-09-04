// Static pins over the migration chain in supabase/migrations. The live
// behaviour (grant layer, quota, planner, identity ledger) is asserted by
// supabase/tests/security_regression.sql cases H7, I1–I3, J1–J11, K1–K6 and
// L1–L3 against a real Postgres; this suite guards the chain itself so a
// later migration cannot quietly reopen a closed path, drop a load-bearing
// index, recreate a free-rating decision point on the raw per-account count,
// or drop the table-level permit gate / permit state machine.
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
const IDENTITY_LINK_LEDGER = "20260904140000_ledger_backfill_on_identity_link.sql";
const SHOTS_INSERT_REQUIRES_PERMIT = "20260904140100_shots_insert_requires_permit.sql";
const PERMIT_STATUS_TRANSITIONS = "20260904140200_permit_status_transitions.sql";

/** Every trigger that writes public.free_rating_ledger. The scored-shot writer
 * covers the identities linked at the moment a rating is spent; the identity-
 * link writer covers an identity linked afterwards (otherwise delete +
 * re-sign-in with the late-linked provider starts the free ratings over). */
const LEDGER_WRITING_TRIGGERS: ReadonlyArray<{
  trigger: string;
  create: string;
  fn: string;
  migration: string;
}> = [
  {
    trigger: "shots_record_free_rating_ledger",
    create:
      "create trigger shots_record_free_rating_ledger after insert or update of result_kind on public.shots",
    fn: "record_scored_shot_in_ledger",
    migration: IDENTITY_LEDGER,
  },
  {
    trigger: "identities_sync_free_rating_ledger",
    create: "create trigger identities_sync_free_rating_ledger after insert on auth.identities",
    fn: "sync_free_rating_ledger_on_identity_link",
    migration: IDENTITY_LINK_LEDGER,
  },
];

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
  "shots: a scored INSERT is gated at the table (permit + lifetime limit), not only inside the RPC",
  async () => {
    const chain = await loadChain();
    const gate = chain.find((m) => m.file === SHOTS_INSERT_REQUIRES_PERMIT);
    ok(gate, `${SHOTS_INSERT_REQUIRES_PERMIT} must exist in the migration chain`);

    const create = gate.statements.find((s) =>
      s.startsWith("create trigger shots_insert_requires_permit "),
    );
    ok(create, "the gate migration must create shots_insert_requires_permit on public.shots");
    ok(
      create.includes(" before insert on public.shots ") &&
        create.endsWith("for each row execute function public.enforce_scored_shot_permit()"),
      `the gate must be a BEFORE INSERT row trigger running enforce_scored_shot_permit(): ${create}`,
    );

    const bodies = functionBodies(gate.raw, "enforce_scored_shot_permit");
    ok(bodies.length === 1, "the gate migration must define public.enforce_scored_shot_permit()");
    const body = bodies[0];
    ok(body.includes("set search_path = ''"), "the gate must pin search_path");
    ok(
      body.includes("public.lifetime_scored_count()") &&
        !/count\(\*\)[^;]*from public\.shots/.test(body),
      "the gate must count through the identity ledger, never the raw per-account count",
    );
    ok(
      body.includes("from public.analysis_permits") && body.includes("status = 'reserved'"),
      "the gate must require a reserved permit",
    );
    ok(
      body.includes("pg_advisory_xact_lock(public.access_lock_key("),
      "the gate must serialize under the shared per-user access lock",
    );
    ok(
      body.includes("errcode = 'insufficient_privilege'"),
      "a refused scored write must surface as 42501",
    );
    ok(
      gate.statements.includes(
        "revoke execute on function public.enforce_scored_shot_permit() from public, anon, authenticated",
      ),
      "enforce_scored_shot_permit must not be client-executable",
    );

    const check = gate.statements.find(
      (s) =>
        s.startsWith(
          "alter table public.shots add constraint unscored_shots_have_no_score check",
        ) || s.includes("add constraint unscored_shots_have_no_score check"),
    );
    ok(check, "the gate migration must add the unscored_shots_have_no_score CHECK");
    ok(
      /result_kind = 'scored' or overall_score is null/.test(check),
      `low_confidence rows must not carry a score: ${check}`,
    );

    for (const migration of after(chain, SHOTS_INSERT_REQUIRES_PERMIT)) {
      for (const statement of migration.statements) {
        ok(
          !(
            statement.startsWith("drop trigger") &&
            statement.includes("shots_insert_requires_permit") &&
            !migration.statements.some((s) =>
              s.startsWith("create trigger shots_insert_requires_permit "),
            )
          ),
          `${migration.file} drops shots_insert_requires_permit without recreating it`,
        );
        ok(
          !(
            statement.startsWith("alter table public.shots") &&
            /disable trigger (all|user|shots_insert_requires_permit)\b/.test(statement)
          ),
          `${migration.file} disables the shots insert gate: ${statement}`,
        );
        ok(
          !(
            statement.startsWith("alter table public.shots drop constraint") &&
            statement.includes("unscored_shots_have_no_score")
          ),
          `${migration.file} drops unscored_shots_have_no_score`,
        );
      }
    }
  },
);

Deno.test("permits: terminal statuses are locked by a BEFORE UPDATE trigger", async () => {
  const chain = await loadChain();
  const lock = chain.find((m) => m.file === PERMIT_STATUS_TRANSITIONS);
  ok(lock, `${PERMIT_STATUS_TRANSITIONS} must exist in the migration chain`);

  const create = lock.statements.find((s) =>
    s.startsWith("create trigger analysis_permits_terminal_lock "),
  );
  ok(create, "the transitions migration must create analysis_permits_terminal_lock");
  ok(
    create.includes(" before update ") &&
      create.includes(" on public.analysis_permits ") &&
      create.endsWith("for each row execute function public.reject_terminal_permit_transition()"),
    `the lock must be a BEFORE UPDATE row trigger on public.analysis_permits: ${create}`,
  );

  const bodies = functionBodies(lock.raw, "reject_terminal_permit_transition");
  ok(
    bodies.length === 1,
    "the transitions migration must define reject_terminal_permit_transition()",
  );
  const body = bodies[0];
  ok(body.includes("set search_path = ''"), "the lock must pin search_path");
  ok(
    body.includes("old.status <> 'reserved'") || body.includes("old.status in ("),
    "the lock must key off the OLD (terminal) status",
  );
  ok(
    body.includes("new.status is distinct from old.status") &&
      body.includes("new.outcome is distinct from old.outcome"),
    "the lock must reject both a status change and an outcome change once terminal",
  );
  ok(
    body.includes("errcode = 'insufficient_privilege'"),
    "a refused permit transition must surface as 42501",
  );
  ok(
    lock.statements.includes(
      "revoke execute on function public.reject_terminal_permit_transition() from public, anon, authenticated",
    ),
    "reject_terminal_permit_transition must not be client-executable",
  );

  for (const migration of after(chain, PERMIT_STATUS_TRANSITIONS)) {
    for (const statement of migration.statements) {
      ok(
        !(
          statement.startsWith("drop trigger") &&
          statement.includes("analysis_permits_terminal_lock") &&
          !migration.statements.some((s) =>
            s.startsWith("create trigger analysis_permits_terminal_lock "),
          )
        ),
        `${migration.file} drops analysis_permits_terminal_lock without recreating it`,
      );
      ok(
        !(
          statement.startsWith("alter table public.analysis_permits") &&
          /disable trigger (all|user|analysis_permits_terminal_lock)\b/.test(statement)
        ),
        `${migration.file} disables the permit state machine: ${statement}`,
      );
    }
  }
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
    for (const writer of LEDGER_WRITING_TRIGGERS) {
      const migration = chain.find((m) => m.file === writer.migration);
      ok(migration, `${writer.migration} must exist in the migration chain`);
      ok(
        migration.statements.some((s) => s.startsWith(writer.create)),
        `${writer.migration} must create ${writer.trigger}: ${writer.create}`,
      );
      const bodies = functionBodies(migration.raw, writer.fn);
      ok(bodies.length === 1, `${writer.migration} must define public.${writer.fn}()`);
      ok(
        bodies[0].includes("security definer") && bodies[0].includes("set search_path = ''"),
        `public.${writer.fn} must be SECURITY DEFINER with a pinned search_path`,
      );
      ok(
        /insert into public\.free_rating_ledger[\s\S]*on conflict \(identity_hash\) do update[\s\S]*greatest\(/.test(
          bodies[0],
        ),
        `public.${writer.fn} must upsert the ledger with greatest(...) (never lower a count)`,
      );
      ok(
        migration.statements.includes(
          `revoke execute on function public.${writer.fn}() from public, anon, authenticated`,
        ),
        `public.${writer.fn} must not be client-executable`,
      );
    }
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
        for (const writer of LEDGER_WRITING_TRIGGERS) {
          ok(
            !(
              statement.startsWith("drop trigger") &&
              statement.includes(writer.trigger) &&
              !migration.statements.some((s) => s.startsWith(`create trigger ${writer.trigger} `))
            ),
            `${migration.file} drops ${writer.trigger} without recreating it`,
          );
        }
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
