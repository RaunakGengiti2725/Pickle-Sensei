// Live grant / RLS / RPC drift matrix.
//
// Joins the static access inventory (write_inventory.ts — every PostgREST
// read/write/RPC the edge function performs, with exact payload columns) to
// the privileges the migrations ACTUALLY leave behind in a throwaway Postgres
// that has supabase/tests/shim_auth.sql + every migration applied
// (the same setup as supabase/tests/run_rls_tests.sh).
//
// For every access it answers three questions from the catalog
// (has_table_privilege / has_column_privilege / pg_policies /
// has_function_privilege) and then EXECUTES the PostgREST-equivalent SQL as
// the `authenticated` role with a JWT sub inside a rolled-back transaction,
// recording the SQLSTATE. 42501 = grant/RLS drift (the edge fn would turn it
// into a 503). Negative controls (writes the migrations promise to deny) must
// return 42501 or the matrix is not trusted.
//
// It also inventories every public function: EXECUTE per role vs. whether
// the edge function ever calls it (unused/over-exposed RPC surface).
//
//   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno run -A --no-check --config tools/audit/static_health_edge_db/deno.json \
//     tools/audit/static_health_edge_db/grant_matrix.ts --out grant_matrix.json
//
// Exit 0 when every authenticated/service_role access is permitted and every
// negative control is denied; 1 otherwise. Never points at hosted Supabase.

import postgres from "postgres";
import { inventory, type DbAccess } from "./write_inventory.ts";
import { print } from "./lib/print.ts";

type Sql = ReturnType<typeof postgres>;

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
if (!PG_URL) {
  console.error("PICKLE_AUDIT_PG_URL is required (throwaway Postgres with shim + migrations).");
  Deno.exit(2);
}
if (/supabase\.(co|com)|ucqnaiwqwjtgvlduiuib/.test(PG_URL)) {
  console.error("Refusing to run against a hosted Supabase URL.");
  Deno.exit(2);
}

const ROLES = ["anon", "authenticated", "service_role"] as const;
type Role = (typeof ROLES)[number];
const USER_A = "0000aaaa-0000-4000-8000-00000000000a";
const USER_B = "0000bbbb-0000-4000-8000-00000000000b";

interface ColumnInfo {
  table: string;
  column: string;
  dataType: string;
  udt: string;
  nullable: boolean;
  hasDefault: boolean;
}

interface RelationInfo {
  name: string;
  kind: string; // r=table v=view m=matview p=partitioned
  rls: boolean;
  forceRls: boolean;
  columns: ColumnInfo[];
  checks: Array<{ name: string; def: string }>;
  tablePrivs: Record<Role, string[]>;
  columnPrivs: Record<Role, Record<string, string[]>>;
  policies: Array<{
    name: string;
    cmd: string;
    roles: string[];
    permissive: boolean;
    qual: string | null;
    withCheck: string | null;
  }>;
}

interface FunctionInfo {
  name: string;
  signature: string;
  args: string[];
  returns: string;
  securityDefiner: boolean;
  volatility: string;
  exec: Record<Role, boolean>;
  execPublic: boolean;
  isTrigger: boolean;
  calledFromEdge: boolean;
  /** Called (transitively) from a function the edge fn invokes, or fired by
   * a trigger on a table the edge fn / such a function writes. */
  reachableFromEdge: boolean;
  /** public.<fn> names referenced in the body */
  callsFunctions: string[];
  /** public.<table> names written (insert/update/delete) in the body */
  writesTables: string[];
  body: string;
}

interface AccessVerdict {
  access: DbAccess;
  staticChecks: Array<{ check: string; ok: boolean; detail: string }>;
  staticOk: boolean;
  live: {
    sql: string;
    sqlstate: string | null;
    message: string | null;
    ok: boolean;
    classification: string;
  } | null;
  ok: boolean;
}

interface Control {
  id: string;
  role: Role;
  sql: string;
  expectSqlstate: string;
  why: string;
}

async function catalog(sql: Sql): Promise<{
  relations: RelationInfo[];
  functions: FunctionInfo[];
  triggers: Array<{ table: string; fn: string }>;
}> {
  const rels = await sql<Array<{ name: string; kind: string; rls: boolean; force: boolean }>>`
    select c.relname as name, c.relkind::text as kind, c.relrowsecurity as rls, c.relforcerowsecurity as force
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','v','m','p')
    order by c.relname`;
  const cols = await sql<
    Array<{
      table: string;
      column: string;
      data_type: string;
      udt: string;
      nullable: string;
      has_default: boolean;
    }>
  >`
    select table_name as "table", column_name as "column", data_type, udt_name as udt, is_nullable as nullable,
           column_default is not null as has_default
    from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`;
  const checks = await sql<Array<{ table: string; name: string; def: string }>>`
    select rel.relname as "table", con.conname as name, pg_get_constraintdef(con.oid) as def
    from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.contype = 'c'`;
  const policies = await sql<
    Array<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string[];
      permissive: string;
      qual: string | null;
      with_check: string | null;
    }>
  >`
    select tablename, policyname, cmd, roles::text[] as roles, permissive, qual, with_check from pg_policies where schemaname = 'public'`;

  const relations: RelationInfo[] = [];
  for (const r of rels) {
    const info: RelationInfo = {
      name: r.name,
      kind: r.kind,
      rls: r.rls,
      forceRls: r.force,
      columns: cols
        .filter((c) => c.table === r.name)
        .map((c) => ({
          table: c.table,
          column: c.column,
          dataType: c.data_type,
          udt: c.udt,
          nullable: c.nullable === "YES",
          hasDefault: c.has_default,
        })),
      checks: checks.filter((c) => c.table === r.name).map((c) => ({ name: c.name, def: c.def })),
      tablePrivs: { anon: [], authenticated: [], service_role: [] },
      columnPrivs: { anon: {}, authenticated: {}, service_role: {} },
      policies: policies
        .filter((p) => p.tablename === r.name)
        .map((p) => ({
          name: p.policyname,
          cmd: p.cmd,
          roles: p.roles,
          permissive: p.permissive === "PERMISSIVE",
          qual: p.qual,
          withCheck: p.with_check,
        })),
    };
    for (const role of ROLES) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const [{ ok }] = await sql<Array<{ ok: boolean }>>`
          select has_table_privilege(${role}, ${`public.${r.name}`}, ${priv}) as ok`;
        if (ok) info.tablePrivs[role].push(priv);
      }
      for (const c of info.columns) {
        const privs: string[] = [];
        for (const priv of ["SELECT", "INSERT", "UPDATE"]) {
          const [{ ok }] = await sql<Array<{ ok: boolean }>>`
            select has_column_privilege(${role}, ${`public.${r.name}`}, ${c.column}, ${priv}) as ok`;
          if (ok) privs.push(priv);
        }
        info.columnPrivs[role][c.column] = privs;
      }
    }
    relations.push(info);
  }

  const fns = await sql<
    Array<{
      oid: number;
      name: string;
      signature: string;
      args: string | null;
      returns: string;
      secdef: boolean;
      volatility: string;
      body: string;
    }>
  >`
    select p.oid::int as oid, p.proname as name, p.oid::regprocedure::text as signature,
           pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
           p.prosecdef as secdef, p.provolatile::text as volatility, p.prosrc as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' order by p.proname`;
  const functions: FunctionInfo[] = [];
  for (const f of fns) {
    const exec: Record<Role, boolean> = { anon: false, authenticated: false, service_role: false };
    for (const role of ROLES) {
      const [{ ok }] = await sql<Array<{ ok: boolean }>>`
        select has_function_privilege(${role}, ${f.oid}::oid, 'EXECUTE') as ok`;
      exec[role] = ok;
    }
    const [{ pub }] = await sql<Array<{ pub: boolean }>>`
      select coalesce((select true from pg_proc p where p.oid = ${f.oid}::oid and p.proacl is null), false)
             or exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = ${f.oid}::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub`;
    functions.push({
      name: f.name,
      signature: f.signature,
      args: (f.args ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      returns: f.returns,
      securityDefiner: f.secdef,
      volatility: f.volatility,
      exec,
      execPublic: pub,
      isTrigger: f.returns === "trigger",
      calledFromEdge: false,
      reachableFromEdge: false,
      callsFunctions: [
        ...new Set([...f.body.matchAll(/public\.([a-z_][a-z0-9_]*)\s*\(/g)].map((m) => m[1])),
      ].filter((n) => n !== f.name),
      writesTables: [
        ...new Set(
          [
            ...f.body.matchAll(
              /(?:insert\s+into|update|delete\s+from)\s+public\.([a-z_][a-z0-9_]*)/gi,
            ),
          ].map((m) => m[1].toLowerCase()),
        ),
      ],
      body: f.body,
    });
  }
  const triggers = await sql<Array<{ table: string; fn: string }>>`
    select c.relname as "table", p.proname as fn from pg_trigger t
    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid where n.nspname = 'public' and not t.tgisinternal`;
  for (const f of functions)
    f.callsFunctions = f.callsFunctions.filter((n) => functions.some((g) => g.name === n));
  return { relations, functions, triggers };
}

function pickCheckValue(rel: RelationInfo, column: string): string | null {
  for (const c of rel.checks) {
    const m = c.def.match(new RegExp(`\\(?${column}\\s*=\\s*ANY\\s*\\(ARRAY\\[([^\\]]+)\\]`, "i"));
    if (m) {
      const first = m[1]
        .split(",")[0]
        .trim()
        .replace(/::text$/, "")
        .replace(/^'|'$/g, "");
      return first;
    }
    const m2 = c.def.match(new RegExp(`${column}\\s+IN\\s*\\(('[^']*')`, "i"));
    if (m2) return m2[1].replace(/^'|'$/g, "");
  }
  return null;
}

/** A plausible literal for a column, preferring the value the edge fn writes
 * literally, then CHECK-constraint enumerations, then the type. */
function valueFor(rel: RelationInfo, access: DbAccess, column: string, userId: string): string {
  const col = rel.columns.find((c) => c.column === column);
  const lit = access.literalValues[column];
  if (lit !== undefined) return `'${lit.replace(/'/g, "''")}'`;
  if (!col) return "null";
  if (column === "user_id" || column === "app_user_id") return `'${userId}'::uuid`;
  const enumValue = pickCheckValue(rel, column);
  switch (col.udt) {
    case "uuid":
      return `'${crypto.randomUUID()}'::uuid`;
    case "text":
    case "varchar":
    case "citext":
      return enumValue ? `'${enumValue}'` : `'xc-probe'`;
    case "timestamptz":
    case "timestamp":
      return column.startsWith("expires") ? `now() + interval '1 hour'` : `now()`;
    case "date":
      return `current_date`;
    case "jsonb":
    case "json":
      return `'{}'::jsonb`;
    case "bool":
      return `false`;
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return `1`;
    case "bytea":
      return `'\\x00'::bytea`;
    default:
      return "null";
  }
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** The SQL PostgREST would issue for this access (payload column set is what
 * matters for privilege checks; values only need to reach the privilege
 * check, which happens before constraints). */
function postgrestSql(rel: RelationInfo, access: DbAccess, userId: string): string {
  const t = `public.${quoteIdent(rel.name)}`;
  const cols = access.columns.map(quoteIdent).join(", ");
  const vals = access.columns.map((c) => valueFor(rel, access, c, userId)).join(", ");
  const returning =
    access.selectColumns.length > 0
      ? ` returning ${access.selectColumns.map(quoteIdent).join(", ")}`
      : "";
  const filterCols = access.filterColumns.length > 0 ? access.filterColumns : ["user_id"];
  const where =
    filterCols
      .filter((c) => rel.columns.some((rc) => rc.column === c))
      .map(
        (c) =>
          `${quoteIdent(c)} = ${c === "user_id" || (c === "id" && rel.name === "profiles") ? `'${userId}'::uuid` : valueFor(rel, access, c, userId)}`,
      )
      .join(" and ") || "true";
  switch (access.op) {
    case "insert":
      return `insert into ${t} (${cols}) values (${vals})${returning}`;
    case "upsert": {
      const conflict = (access.upsert?.onConflict ?? "id")
        .split(",")
        .map((s) => quoteIdent(s.trim()))
        .join(", ");
      if (access.upsert?.ignoreDuplicates) {
        return `insert into ${t} (${cols}) values (${vals}) on conflict (${conflict}) do nothing${returning}`;
      }
      const set = access.columns
        .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
        .join(", ");
      return `insert into ${t} (${cols}) values (${vals}) on conflict (${conflict}) do update set ${set}${returning}`;
    }
    case "update": {
      const set = access.columns
        .map((c) => `${quoteIdent(c)} = ${valueFor(rel, access, c, userId)}`)
        .join(", ");
      return `update ${t} set ${set} where ${where}${returning}`;
    }
    case "delete":
      return `delete from ${t} where ${where}${returning}`;
    case "select": {
      const sel =
        access.selectColumns.length > 0 ? access.selectColumns.map(quoteIdent).join(", ") : "*";
      return `select ${sel} from ${t} where ${where} limit 1`;
    }
    default:
      return "select 1";
  }
}

function rpcSql(access: DbAccess, fn: FunctionInfo | undefined): string {
  const args = (access.rpcArgs ?? []).map((a) => {
    const decl = fn?.args.find((d) => d.startsWith(`${a} `));
    const type = decl ? decl.slice(a.length + 1) : "text";
    if (type === "jsonb") return `${a} => '{}'::jsonb`;
    if (type === "uuid") return `${a} => '${crypto.randomUUID()}'::uuid`;
    return `${a} => 'xc-probe'`;
  });
  return `select public.${quoteIdent(access.target)}(${args.join(", ")})`;
}

async function runAs(
  sql: Sql,
  role: Role,
  userId: string | null,
  statement: string,
): Promise<{ sqlstate: string | null; message: string | null }> {
  let result: { sqlstate: string | null; message: string | null } = {
    sqlstate: null,
    message: null,
  };
  try {
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql;
      await t.unsafe(
        `insert into auth.users (id, email) values ('${USER_A}', 'a@example.com') on conflict do nothing`,
      );
      await t.unsafe(
        `insert into auth.users (id, email) values ('${USER_B}', 'b@example.com') on conflict do nothing`,
      );
      await t.unsafe(`set local role ${role}`);
      if (userId) await t.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
      try {
        await t.unsafe(statement);
      } catch (error) {
        const e = error as { code?: string; message?: string };
        result = { sqlstate: e.code ?? null, message: e.message ?? String(error) };
      }
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
  }
  return result;
}

function classify(sqlstate: string | null): { ok: boolean; classification: string } {
  if (sqlstate === null) return { ok: true, classification: "executed" };
  if (sqlstate === "42501") return { ok: false, classification: "permission_denied" };
  if (sqlstate === "42P01" || sqlstate === "42703" || sqlstate === "42883")
    return { ok: false, classification: "missing_object" };
  if (sqlstate.startsWith("23"))
    return { ok: true, classification: "privilege_passed_constraint_failed" };
  if (sqlstate.startsWith("22")) return { ok: true, classification: "privilege_passed_data_error" };
  if (sqlstate === "P0001") return { ok: true, classification: "privilege_passed_raise" };
  return { ok: true, classification: `privilege_passed_${sqlstate}` };
}

function policyCovers(
  rel: RelationInfo,
  role: Role,
  cmd: "SELECT" | "INSERT" | "UPDATE" | "DELETE",
): boolean {
  if (!rel.rls || (rel.kind !== "r" && rel.kind !== "p")) return true;
  return rel.policies.some(
    (p) =>
      (p.cmd === cmd || p.cmd === "ALL") &&
      (p.roles.includes(role) || p.roles.includes("public") || p.roles.includes("{public}")),
  );
}

function staticVerdict(
  access: DbAccess,
  relations: RelationInfo[],
  functions: FunctionInfo[],
): AccessVerdict["staticChecks"] {
  const checks: AccessVerdict["staticChecks"] = [];
  const role: Role = access.role === "service_role" ? "service_role" : "authenticated";
  if (access.op === "rpc") {
    const fn = functions.find((f) => f.name === access.target);
    checks.push({
      check: "function_exists",
      ok: Boolean(fn),
      detail: fn?.signature ?? `public.${access.target} not found`,
    });
    if (fn) {
      checks.push({
        check: "execute_granted",
        ok: fn.exec[role],
        detail: `EXECUTE for ${role}: ${fn.exec[role]}`,
      });
      const declared = fn.args.map((a) => a.split(" ")[0]);
      const missing = (access.rpcArgs ?? []).filter((a) => !declared.includes(a));
      checks.push({
        check: "rpc_args_match",
        ok: missing.length === 0,
        detail: missing.length ? `unknown args ${missing.join(",")}` : `args ${declared.join(",")}`,
      });
    }
    return checks;
  }
  const rel = relations.find((r) => r.name === access.target);
  checks.push({
    check: "relation_exists",
    ok: Boolean(rel),
    detail: rel ? `${rel.kind} rls=${rel.rls}` : `public.${access.target} not found`,
  });
  if (!rel) return checks;
  const allCols = [...access.columns, ...access.selectColumns, ...access.filterColumns];
  const unknownCols = allCols.filter((c) => !rel.columns.some((rc) => rc.column === c));
  checks.push({
    check: "columns_exist",
    ok: unknownCols.length === 0,
    detail: unknownCols.length ? `unknown ${unknownCols.join(",")}` : `${allCols.length} columns`,
  });
  const needSelect = [...new Set([...access.selectColumns, ...access.filterColumns])];
  const noSelect = needSelect.filter((c) => !(rel.columnPrivs[role][c] ?? []).includes("SELECT"));
  if (needSelect.length)
    checks.push({
      check: "select_grant_on_read_columns",
      ok: noSelect.length === 0,
      detail: noSelect.length ? `no SELECT on ${noSelect.join(",")}` : "ok",
    });
  if (access.op === "select") {
    checks.push({
      check: "rls_policy_select",
      ok: policyCovers(rel, role, "SELECT") || role === "service_role",
      detail: rel.policies.map((p) => `${p.name}:${p.cmd}`).join(" "),
    });
  }
  if (access.op === "insert" || access.op === "upsert") {
    const noInsert = access.columns.filter(
      (c) => !(rel.columnPrivs[role][c] ?? []).includes("INSERT"),
    );
    checks.push({
      check: "insert_grant_on_payload_columns",
      ok: noInsert.length === 0,
      detail: noInsert.length ? `no INSERT on ${noInsert.join(",")}` : "ok",
    });
    checks.push({
      check: "rls_policy_insert",
      ok: policyCovers(rel, role, "INSERT") || role === "service_role",
      detail:
        rel.policies
          .filter((p) => p.cmd === "INSERT" || p.cmd === "ALL")
          .map((p) => p.name)
          .join(",") || "none",
    });
  }
  if (access.op === "upsert" && !access.upsert?.ignoreDuplicates) {
    const noUpdate = access.columns.filter(
      (c) => !(rel.columnPrivs[role][c] ?? []).includes("UPDATE"),
    );
    checks.push({
      check: "update_grant_on_all_merge_columns",
      ok: noUpdate.length === 0,
      detail: noUpdate.length
        ? `merge-duplicates sets ${noUpdate.join(",")} without UPDATE grant`
        : "ok",
    });
    checks.push({
      check: "rls_policy_update",
      ok: policyCovers(rel, role, "UPDATE") || role === "service_role",
      detail:
        rel.policies
          .filter((p) => p.cmd === "UPDATE" || p.cmd === "ALL")
          .map((p) => p.name)
          .join(",") || "none",
    });
  }
  if (access.op === "update") {
    const noUpdate = access.columns.filter(
      (c) => !(rel.columnPrivs[role][c] ?? []).includes("UPDATE"),
    );
    checks.push({
      check: "update_grant_on_payload_columns",
      ok: noUpdate.length === 0,
      detail: noUpdate.length ? `no UPDATE on ${noUpdate.join(",")}` : "ok",
    });
    checks.push({
      check: "rls_policy_update",
      ok: policyCovers(rel, role, "UPDATE") || role === "service_role",
      detail:
        rel.policies
          .filter((p) => p.cmd === "UPDATE" || p.cmd === "ALL")
          .map((p) => p.name)
          .join(",") || "none",
    });
  }
  if (access.op === "delete") {
    checks.push({
      check: "delete_grant",
      ok: rel.tablePrivs[role].includes("DELETE"),
      detail: rel.tablePrivs[role].join(","),
    });
    checks.push({
      check: "rls_policy_delete",
      ok: policyCovers(rel, role, "DELETE") || role === "service_role",
      detail:
        rel.policies
          .filter((p) => p.cmd === "DELETE" || p.cmd === "ALL")
          .map((p) => p.name)
          .join(",") || "none",
    });
  }
  return checks;
}

/** Writes the migrations promise to DENY. Each must yield 42501, proving the
 * live matrix is sensitive (not vacuously green). */
const CONTROLS: Control[] = [
  {
    id: "shots_update_denied",
    role: "authenticated",
    sql: `update public.shots set overall_score = 1 where user_id = '${USER_A}'`,
    expectSqlstate: "42501",
    why: "shots have no client UPDATE grant",
  },
  {
    id: "shots_delete_denied",
    role: "authenticated",
    sql: `delete from public.shots where user_id = '${USER_A}'`,
    expectSqlstate: "42501",
    why: "20260902130000 revokes client DELETE",
  },
  {
    id: "sessions_started_at_update_denied",
    role: "authenticated",
    sql: `update public.sessions set started_at = now() where user_id = '${USER_A}'`,
    expectSqlstate: "42501",
    why: "sessions grant is ended_at only",
  },
  {
    id: "permits_idempotency_update_denied",
    role: "authenticated",
    sql: `update public.analysis_permits set idempotency_key = 'x' where user_id = '${USER_A}'`,
    expectSqlstate: "42501",
    why: "permits grant is status/outcome only",
  },
  {
    id: "profiles_email_update_denied",
    role: "authenticated",
    sql: `update public.profiles set email = 'x@example.com' where id = '${USER_A}'`,
    expectSqlstate: "42501",
    why: "identity columns not client-writable",
  },
  {
    id: "profiles_insert_denied",
    role: "authenticated",
    sql: `insert into public.profiles (id, email) values ('${USER_A}', 'a@example.com')`,
    expectSqlstate: "42501",
    why: "profiles are trigger-created only",
  },
  {
    id: "billing_entitlements_insert_denied",
    role: "authenticated",
    sql: `insert into public.billing_entitlements (user_id, premium) values ('${USER_A}', true)`,
    expectSqlstate: "42501",
    why: "service-only table",
  },
  {
    id: "billing_entitlements_update_denied",
    role: "authenticated",
    sql: `update public.billing_entitlements set premium = true where user_id = '${USER_A}'`,
    expectSqlstate: "42501",
    why: "service-only table",
  },
  {
    id: "webhook_events_select_denied",
    role: "authenticated",
    sql: `select count(*) from public.webhook_events`,
    expectSqlstate: "42501",
    why: "service-only table",
  },
  {
    id: "free_rating_ledger_select_denied",
    role: "authenticated",
    sql: `select count(*) from public.free_rating_ledger`,
    expectSqlstate: "42501",
    why: "service-only ledger",
  },
  {
    id: "free_rating_ledger_insert_denied",
    role: "authenticated",
    sql: `insert into public.free_rating_ledger (identity_hash, scored_count) values ('x', 99)`,
    expectSqlstate: "42501",
    why: "service-only ledger",
  },
  {
    id: "consent_records_update_denied",
    role: "authenticated",
    sql: `update public.consent_records set action = 'granted' where user_id = '${USER_A}'`,
    expectSqlstate: "42501",
    why: "append-only ledger",
  },
  {
    id: "account_external_credentials_select_denied",
    role: "authenticated",
    sql: `select count(*) from public.account_external_credentials`,
    expectSqlstate: "42501",
    why: "service-only credentials",
  },
  {
    id: "anon_profiles_select_denied",
    role: "anon",
    sql: `select count(*) from public.profiles`,
    expectSqlstate: "42501",
    why: "anon has no table access",
  },
  {
    id: "anon_access_state_denied",
    role: "anon",
    sql: `select public.access_state()`,
    expectSqlstate: "42501",
    why: "RPCs not executable by anon",
  },
  {
    id: "anon_apply_synced_shot_denied",
    role: "anon",
    sql: `select public.apply_synced_shot('{}'::jsonb)`,
    expectSqlstate: "42501",
    why: "RPCs not executable by anon",
  },
  {
    id: "cross_user_session_update_no_rows",
    role: "authenticated",
    sql: `update public.sessions set ended_at = now() where user_id = '${USER_B}'`,
    expectSqlstate: "__zero_rows__",
    why: "RLS hides other users' rows (0 rows, not an error)",
  },
];

async function main() {
  const outIdx = Deno.args.indexOf("--out");
  const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
  const accesses = inventory();
  const { relations, functions, triggers } = await catalog(sql);
  const calledRpcs = new Set(accesses.filter((a) => a.op === "rpc").map((a) => a.target));
  for (const f of functions) f.calledFromEdge = calledRpcs.has(f.name);
  // Transitive reachability: edge → RPC → helper functions; edge/RPC writes →
  // triggers on those tables → their functions → helpers.
  const writtenTables = new Set(
    accesses.filter((a) => a.op !== "select" && a.op !== "rpc").map((a) => a.target),
  );
  const reach = new Set<string>(calledRpcs);
  for (;;) {
    const before = reach.size;
    for (const f of functions) {
      if (!reach.has(f.name)) continue;
      for (const c of f.callsFunctions) reach.add(c);
      for (const t of f.writesTables) writtenTables.add(t);
    }
    for (const t of triggers) if (writtenTables.has(t.table)) reach.add(t.fn);
    if (reach.size === before) break;
  }
  for (const f of functions) f.reachableFromEdge = reach.has(f.name);
  const tablesWrittenViaRpc = [...writtenTables].filter(
    (t) => !accesses.some((a) => a.target === t && a.op !== "select" && a.op !== "rpc"),
  );

  const verdicts: AccessVerdict[] = [];
  for (const access of accesses) {
    const staticChecks = staticVerdict(access, relations, functions);
    const staticOk = staticChecks.every((c) => c.ok);
    const role: Role = access.role === "service_role" ? "service_role" : "authenticated";
    let live: AccessVerdict["live"] = null;
    const rel = relations.find((r) => r.name === access.target);
    if (access.op === "rpc") {
      const statement = rpcSql(
        access,
        functions.find((f) => f.name === access.target),
      );
      const r = await runAs(sql, role, USER_A, statement);
      live = { sql: statement, ...r, ...classify(r.sqlstate) };
    } else if (rel && !access.opaque) {
      const statement = postgrestSql(rel, access, USER_A);
      const r = await runAs(sql, role, role === "service_role" ? null : USER_A, statement);
      live = { sql: statement, ...r, ...classify(r.sqlstate) };
    }
    verdicts.push({
      access,
      staticChecks,
      staticOk,
      live,
      ok: staticOk && (live ? live.ok : true),
    });
  }

  const controlResults: Array<
    Control & { sqlstate: string | null; message: string | null; ok: boolean }
  > = [];
  for (const c of CONTROLS) {
    const r = await runAs(sql, c.role, c.role === "anon" ? null : USER_A, c.sql);
    const ok =
      c.expectSqlstate === "__zero_rows__" ? r.sqlstate === null : r.sqlstate === c.expectSqlstate;
    controlResults.push({ ...c, ...r, ok });
  }

  // Every table the client roles can touch at all, for the raw matrix.
  const matrix = relations.map((r) => ({
    relation: r.name,
    kind: r.kind,
    rls: r.rls,
    forceRls: r.forceRls,
    tablePrivs: r.tablePrivs,
    columnUpdateGrants: Object.fromEntries(
      ROLES.map((role) => [
        role,
        Object.entries(r.columnPrivs[role])
          .filter(([, p]) => p.includes("UPDATE"))
          .map(([c]) => c),
      ]),
    ),
    columnInsertGrants: Object.fromEntries(
      ROLES.map((role) => [
        role,
        Object.entries(r.columnPrivs[role])
          .filter(([, p]) => p.includes("INSERT"))
          .map(([c]) => c),
      ]),
    ),
    columnSelectGrants: Object.fromEntries(
      ROLES.map((role) => [
        role,
        Object.entries(r.columnPrivs[role])
          .filter(([, p]) => p.includes("SELECT"))
          .map(([c]) => c),
      ]),
    ),
    policies: r.policies,
    touchedByEdge: accesses.filter((a) => a.target === r.name).map((a) => `${a.op}@${a.line}`),
  }));

  const rlsOffTables = relations
    .filter((r) => (r.kind === "r" || r.kind === "p") && !r.rls)
    .map((r) => r.name);
  const clientReachableUntouched = relations
    .filter(
      (r) =>
        (r.tablePrivs.authenticated.length > 0 || r.tablePrivs.anon.length > 0) &&
        !accesses.some((a) => a.target === r.name) &&
        !writtenTables.has(r.name),
    )
    .map((r) => ({
      relation: r.name,
      kind: r.kind,
      authenticated: r.tablePrivs.authenticated,
      anon: r.tablePrivs.anon,
      writtenByAnyFunction: functions
        .filter((f) => f.writesTables.includes(r.name))
        .map((f) => f.name),
    }));
  const anonReachable = relations
    .filter((r) => r.tablePrivs.anon.length > 0)
    .map((r) => ({ relation: r.name, anon: r.tablePrivs.anon }));
  // Column-level grants wider than what the edge fn writes (drift in the
  // permissive direction: the migration comments promise "exactly the writes").
  const overGrantedUpdateColumns = relations
    .filter(
      (r) =>
        r.tablePrivs.authenticated.length > 0 ||
        Object.values(r.columnPrivs.authenticated).some((p) => p.includes("UPDATE")),
    )
    .map((r) => {
      const granted = Object.entries(r.columnPrivs.authenticated)
        .filter(([, p]) => p.includes("UPDATE"))
        .map(([c]) => c);
      const written = new Set(
        accesses
          .filter(
            (a) =>
              a.target === r.name &&
              a.role === "authenticated" &&
              (a.op === "update" || (a.op === "upsert" && !a.upsert?.ignoreDuplicates)),
          )
          .flatMap((a) => a.columns),
      );
      return {
        relation: r.name,
        grantedUpdate: granted,
        writtenByEdge: [...written],
        unusedGrant: granted.filter((c) => !written.has(c)),
      };
    })
    .filter((r) => r.grantedUpdate.length > 0);
  const rpcSurface = functions.map((f) => ({
    name: f.name,
    signature: f.signature,
    returns: f.returns,
    securityDefiner: f.securityDefiner,
    exec: f.exec,
    execPublic: f.execPublic,
    isTrigger: f.isTrigger,
    calledFromEdge: f.calledFromEdge,
    reachableFromEdge: f.reachableFromEdge,
    callsFunctions: f.callsFunctions,
    writesTables: f.writesTables,
  }));
  const exposedUnused = rpcSurface.filter(
    (f) => (f.exec.authenticated || f.exec.anon) && !f.reachableFromEdge && !f.isTrigger,
  );
  const anonExecutable = rpcSurface.filter((f) => f.exec.anon);
  const triggersExecutable = rpcSurface.filter(
    (f) => f.isTrigger && (f.exec.anon || f.exec.authenticated),
  );
  const definerExposed = rpcSurface.filter(
    (f) => f.securityDefiner && (f.exec.anon || f.exec.authenticated),
  );

  const failing = verdicts.filter((v) => !v.ok);
  const controlsFailing = controlResults.filter((c) => !c.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    pgUrlHost: new URL(PG_URL).host,
    accessCount: accesses.length,
    pass: failing.length === 0 && controlsFailing.length === 0,
    summary: {
      accessesChecked: verdicts.length,
      accessesFailing: failing.length,
      liveExecuted: verdicts.filter((v) => v.live).length,
      liveByClassification: Object.fromEntries(
        [...new Set(verdicts.map((v) => v.live?.classification ?? "not_executed"))].map((k) => [
          k,
          verdicts.filter((v) => (v.live?.classification ?? "not_executed") === k).length,
        ]),
      ),
      controls: controlResults.length,
      controlsFailing: controlsFailing.length,
      relations: relations.length,
      functions: functions.length,
    },
    failing: failing.map((v) => ({
      access: `${v.access.file}:${v.access.line} ${v.access.op} ${v.access.target}`,
      staticChecks: v.staticChecks.filter((c) => !c.ok),
      live: v.live,
    })),
    controls: controlResults,
    verdicts,
    matrix,
    observations: {
      rlsOffTables,
      anonReachable,
      clientReachableUntouchedByEdge: clientReachableUntouched,
      overGrantedUpdateColumns,
      tablesWrittenOnlyViaRpc: tablesWrittenViaRpc,
      rpc: {
        surface: rpcSurface,
        exposedButUnreachableFromEdge: exposedUnused,
        anonExecutable,
        triggerFunctionsExecutableByClients: triggersExecutable,
        securityDefinerExposedToClients: definerExposed,
      },
    },
  };
  const text = JSON.stringify(report, null, 2);
  if (outIdx >= 0 && Deno.args[outIdx + 1]) Deno.writeTextFileSync(Deno.args[outIdx + 1], text);
  else print(text);
  console.error(
    `accesses ${verdicts.length} (failing ${failing.length}); live ${JSON.stringify(report.summary.liveByClassification)}; controls ${controlResults.length} (failing ${controlsFailing.length}); rpc exposed-uncalled ${exposedUnused.map((f) => f.name).join(",") || "none"}`,
  );
  await sql.end();
  Deno.exit(report.pass ? 0 : 1);
}

await main();
