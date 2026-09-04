#!/usr/bin/env python3
"""Mutation testing for the Supabase RLS / grant security matrix.

Proves that ``supabase/tests/run_rls_tests.sh`` FAILS when any single security
control is dropped or loosened, rather than merely passing on the unmodified
schema. Every mutant is materialised in a SCRATCH copy of ``supabase/`` — the
real migrations and tests are never touched — and the unmodified
``run_rls_tests.sh`` is executed against that copy, so the verdict is exactly
what CI's ``supabase-security`` job would produce.

Two mutant families:

* ``endstate`` — the scratch tree gets ONE extra migration
  (``99999999999999_mutant_<id>.sql``) that weakens or removes exactly one
  control in the final schema: drop / loosen a policy, disable RLS, grant or
  revoke one table / column / function privilege, drop an append-only
  trigger, drop a payload-cap constraint, drop a ledger NOT NULL, flip a
  view's ``security_invoker``, or flip a function's SECURITY mode. Generated
  from the live catalog of a baseline database, so nothing is hand-listed.
* ``source`` — ONE security statement is deleted from ONE migration file
  (grant / revoke / create policy / enable RLS / create trigger / add
  constraint / set not null), including sub-statements inside ``do $$``
  blocks. Deletions that leave the final catalog identical to baseline
  (a later migration re-asserts the control) are reported as EQUIVALENT,
  not as survivors.

Verdicts per mutant (``results.json``):

* ``KILLED``     — run_rls_tests.sh exited non-zero and the first error came
                   from security_regression.sql (a matrix assertion tripped).
* ``SURVIVED``   — run_rls_tests.sh exited 0 AND the mutant changed the
                   security catalog. A survivor is a coverage gap: the matrix
                   does not pin that control.
* ``EQUIVALENT`` — run_rls_tests.sh exited 0 and the security catalog is
                   byte-identical to baseline; the mutation had no effect.
* ``INVALID``    — the mutant migration itself failed to apply (the mutant is
                   malformed, not the matrix).
* ``INFRA``      — Docker / Postgres failure unrelated to the mutant.

Usage (from the repository root):

    python3 supabase/tests/mutation/mutate_rls.py run \
        --out-dir artifacts/rls-mutation/$(date +%s)

    python3 supabase/tests/mutation/mutate_rls.py run --ids E0042,S0007 ...
    python3 supabase/tests/mutation/mutate_rls.py generate --out-dir ...
    python3 supabase/tests/mutation/mutate_rls.py report --out-dir ...

Requirements: Docker with the ``postgres:16`` image (the same prerequisite as
run_rls_tests.sh). Python 3.9+, standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUPABASE_DIR = HERE.parent.parent
MIGRATIONS_DIR = SUPABASE_DIR / "migrations"
TESTS_DIR = SUPABASE_DIR / "tests"
REGRESSION_SQL = TESTS_DIR / "security_regression.sql"
RUN_RLS_TESTS = TESTS_DIR / "run_rls_tests.sh"

SNAPSHOT_CONTAINER = "pickle-rls-mutation-snapshot"
PG_IMAGE = "postgres:16"
MUTANT_MIGRATION_PREFIX = "99999999999999_mutant_"

CLIENT_ROLES = ("anon", "authenticated")
TABLE_PRIVS = ("SELECT", "INSERT", "UPDATE", "DELETE")

# user_id NOT NULL is an explicit control only on the ledgers hardened by
# 20260831160000_defense_in_depth.sql (section 3); on every other table it is a
# plain schema constraint with no client-observable security effect.
LEDGER_NOT_NULL_TABLES = ("consent_records", "evaluation_trials", "analysis_feedback")


# ─────────────────────────────── data model ────────────────────────────────


@dataclass
class Mutant:
    id: str
    family: str  # endstate | source
    category: str
    direction: str  # loosen | tighten
    target: str
    description: str
    sql: str = ""  # endstate: appended migration body
    source_file: str = ""  # source: migration file mutated
    source_span: list[int] = field(default_factory=list)  # [start, end) char offsets
    source_lines: list[int] = field(default_factory=list)  # [first, last] 1-based
    removed_text: str = ""

    def replay_command(self) -> str:
        return f"python3 supabase/tests/mutation/mutate_rls.py run --ids {self.id} --out-dir <out-dir>"


@dataclass
class Result:
    id: str
    verdict: str
    exit_code: int
    duration_s: float
    killed_by: str = ""
    killed_case: str = ""
    killed_line: int = 0
    snapshot_diff_lines: int = 0
    snapshot_diff_sample: list[str] = field(default_factory=list)
    log: str = ""
    mutant_migration: str = ""
    note: str = ""


# ─────────────────────────────── docker/psql ───────────────────────────────


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, **kw)


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    return sh(["docker", "info"]).returncode == 0


class SnapshotDb:
    """A persistent postgres:16 container used to enumerate the catalog and to
    compute security snapshots for equivalence checks. Each ``build`` applies
    the shim + a migrations directory into a FRESH database."""

    def __init__(self, name: str = SNAPSHOT_CONTAINER):
        self.name = name
        self._db_seq = 0

    def __enter__(self) -> SnapshotDb:
        sh(["docker", "rm", "-f", self.name])
        r = sh(
            [
                "docker",
                "run",
                "-d",
                "--name",
                self.name,
                "-e",
                "POSTGRES_PASSWORD=pg",
                PG_IMAGE,
            ]
        )
        if r.returncode != 0:
            raise RuntimeError(f"docker run failed: {r.stderr.strip()}")
        for _ in range(60):
            if sh(["docker", "exec", self.name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("snapshot postgres did not become ready within 60s")
        r = sh(["docker", "cp", str(TESTS_DIR), f"{self.name}:/tests"])
        if r.returncode != 0:
            raise RuntimeError(f"docker cp tests failed: {r.stderr.strip()}")
        return self

    def __exit__(self, *exc) -> None:
        sh(["docker", "rm", "-f", self.name])

    def psql(self, db: str, args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
        return sh(
            ["docker", "exec", "-i", self.name, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", *args],
            input=stdin,
        )

    def build(self, migrations_dir: Path) -> tuple[str, subprocess.CompletedProcess | None]:
        """Create a fresh db, apply shim + every migration in lexical order.
        Returns (dbname, failed_process_or_None)."""
        self._db_seq += 1
        db = f"m{self._db_seq}"
        r = self.psql("postgres", ["-q", "-c", f"create database {db}"])
        if r.returncode != 0:
            return db, r
        r = sh(["docker", "cp", str(migrations_dir), f"{self.name}:/mig_{db}"])
        if r.returncode != 0:
            return db, r
        script = (
            "set -euo pipefail\n"
            f"psql -U postgres -d {db} -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql\n"
            f'for f in /mig_{db}/*.sql; do psql -U postgres -d {db} -v ON_ERROR_STOP=1 -q -f "$f"; done\n'
        )
        r = sh(["docker", "exec", self.name, "bash", "-c", script])
        sh(["docker", "exec", self.name, "rm", "-rf", f"/mig_{db}"])
        return db, (r if r.returncode != 0 else None)

    def drop(self, db: str) -> None:
        self.psql("postgres", ["-q", "-c", f"drop database if exists {db} with (force)"])

    def query(self, db: str, sql: str) -> list[list[str]]:
        r = self.psql(db, ["-At", "-F", "\t"], stdin=sql)
        if r.returncode != 0:
            raise RuntimeError(f"query failed: {r.stderr.strip()}\n{sql}")
        return [line.split("\t") for line in r.stdout.splitlines() if line != ""]


SNAPSHOT_SQL = r"""
-- relations + RLS flags + view options
select 'rel'::text, c.relkind::text, c.relname::text, c.relrowsecurity::text, c.relforcerowsecurity::text,
       coalesce(array_to_string(c.reloptions, ','), '')::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'v')
union all
-- policies
select 'policy', p.tablename::text, p.policyname::text, p.cmd::text, array_to_string(p.roles, ',')::text,
       (coalesce(p.qual, '') || ' || ' || coalesce(p.with_check, '') || ' || ' || p.permissive)::text
from pg_policies p where p.schemaname = 'public'
union all
-- table-level privileges for client roles (PUBLIC folds in)
select 'tabpriv', c.relname::text, r.role::text, pr.priv::text,
       has_table_privilege(r.role, c.oid, pr.priv)::text, ''::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace,
     (values ('anon'), ('authenticated')) r(role),
     (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) pr(priv)
where n.nspname = 'public' and c.relkind in ('r', 'v')
union all
-- column-level privileges for client roles
select 'colpriv', c.relname::text, a.attname::text, (r.role || ':' || pr.priv)::text,
       has_column_privilege(r.role, c.oid, a.attnum, pr.priv)::text, ''::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped,
     (values ('anon'), ('authenticated')) r(role),
     (values ('SELECT'), ('INSERT'), ('UPDATE')) pr(priv)
where n.nspname = 'public' and c.relkind = 'r'
union all
-- functions: security mode + EXECUTE for client roles
select 'func', p.oid::regprocedure::text, p.prosecdef::text,
       coalesce(array_to_string(p.proconfig, ','), '')::text,
       (has_function_privilege('anon', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text)::text, ''::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
union all
-- triggers (public + the auth shim tables)
select 'trigger', (n.nspname || '.' || c.relname)::text, t.tgname::text, t.tgenabled::text,
       pg_get_triggerdef(t.oid)::text, ''::text
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal and n.nspname in ('public', 'auth')
union all
-- check constraints
select 'check', conrelid::regclass::text, conname::text, convalidated::text, pg_get_constraintdef(oid)::text, ''::text
from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace
union all
-- NOT NULL on user_id columns
select 'notnull', c.relname::text, a.attname::text, a.attnotnull::text, ''::text, ''::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and c.relkind = 'r' and a.attname = 'user_id'
order by 1, 2, 3, 4;
"""


def snapshot(db: SnapshotDb, dbname: str) -> list[str]:
    return ["\t".join(row) for row in db.query(dbname, SNAPSHOT_SQL)]


# ───────────────────────────── endstate mutants ────────────────────────────


def truthy(v: str) -> bool:
    return v in ("t", "true")


def q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def generate_endstate(db: SnapshotDb, dbname: str) -> list[Mutant]:
    muts: list[Mutant] = []
    seq = 0

    def add(category: str, direction: str, target: str, description: str, sql: str) -> None:
        nonlocal seq
        seq += 1
        muts.append(
            Mutant(
                id=f"E{seq:04d}",
                family="endstate",
                category=category,
                direction=direction,
                target=target,
                description=description,
                sql=sql,
            )
        )

    # 1. Policies: drop, then loosen to unconditional.
    policies = db.query(
        dbname,
        "select tablename, policyname, cmd from pg_policies where schemaname='public' order by 1,2",
    )
    for table, name, cmd in policies:
        tgt = f"public.{table}.{name}"
        # Policies are permissive: dropping one DENIES that command outright
        # (tighten); loosening its predicate to true is the real weakening.
        add(
            "policy_drop",
            "tighten",
            tgt,
            f"drop policy {name} on {table} ({cmd})",
            f"drop policy {q(name)} on public.{q(table)};",
        )
        cmd_u = cmd.upper()
        if cmd_u == "INSERT":
            clause = "with check (true)"
        elif cmd_u in ("SELECT", "DELETE"):
            clause = "using (true)"
        else:  # UPDATE / ALL
            clause = "using (true) with check (true)"
        add(
            "policy_loosen",
            "loosen",
            tgt,
            f"loosen policy {name} on {table} ({cmd}) to {clause}",
            f"alter policy {q(name)} on public.{q(table)} {clause};",
        )

    # 2. RLS enabled → disabled.
    rels = db.query(
        dbname,
        "select c.relkind, c.relname, c.relrowsecurity, coalesce(array_to_string(c.reloptions, ','), '') "
        "from pg_class c join pg_namespace n on n.oid=c.relnamespace "
        "where n.nspname='public' and c.relkind in ('r','v') order by 2",
    )
    for kind, rel, rls, opts in rels:
        if kind == "r" and truthy(rls):
            add(
                "rls_disable",
                "loosen",
                f"public.{rel}",
                f"disable row level security on {rel}",
                f"alter table public.{q(rel)} disable row level security;",
            )
        if kind == "v" and "security_invoker=true" in opts:
            add(
                "view_definer",
                "loosen",
                f"public.{rel}",
                f"view {rel}: security_invoker=true → false (runs as owner, bypasses RLS)",
                f"alter view public.{q(rel)} set (security_invoker = false);",
            )

    # 3. Table-level privileges: grant what is denied (loosen) / revoke what is granted (tighten).
    tabpriv = db.query(
        dbname,
        "select c.relkind, c.relname, r.role, pr.priv, has_table_privilege(r.role, c.oid, pr.priv)::text "
        "from pg_class c join pg_namespace n on n.oid=c.relnamespace, "
        "(values ('anon'),('authenticated')) r(role), "
        "(values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) pr(priv) "
        "where n.nspname='public' and c.relkind in ('r','v') order by 2,3,4",
    )
    for kind, rel, role, priv, has in tabpriv:
        if kind == "v" and priv != "SELECT":
            continue  # non-updatable derived views: DML grants are inert
        tgt = f"public.{rel}:{role}:{priv}"
        if truthy(has):
            add(
                "table_grant_revoke",
                "tighten",
                tgt,
                f"revoke {priv} on {rel} from {role}",
                f"revoke {priv.lower()} on public.{q(rel)} from {role};",
            )
        else:
            add(
                "table_grant_add",
                "loosen",
                tgt,
                f"grant {priv} on {rel} to {role}",
                f"grant {priv.lower()} on public.{q(rel)} to {role};",
            )

    # 4. Column-level UPDATE privileges for authenticated on tables WITHOUT a
    #    table-level UPDATE grant: the client-writable set must be exact.
    colpriv = db.query(
        dbname,
        "select c.relname, a.attname, has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE')::text, "
        "has_table_privilege('authenticated', c.oid, 'UPDATE')::text "
        "from pg_class c join pg_namespace n on n.oid=c.relnamespace "
        "join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped "
        "where n.nspname='public' and c.relkind='r' order by 1, a.attnum",
    )
    for rel, col, has_col, has_tab in colpriv:
        if truthy(has_tab):
            continue
        tgt = f"public.{rel}.{col}:authenticated:UPDATE"
        if truthy(has_col):
            add(
                "column_grant_revoke",
                "tighten",
                tgt,
                f"revoke update({col}) on {rel} from authenticated",
                f"revoke update ({q(col)}) on public.{q(rel)} from authenticated;",
            )
        else:
            add(
                "column_grant_add",
                "loosen",
                tgt,
                f"grant update({col}) on {rel} to authenticated",
                f"grant update ({q(col)}) on public.{q(rel)} to authenticated;",
            )

    # 5. Functions: EXECUTE grants and SECURITY mode.
    funcs = db.query(
        dbname,
        "select p.oid::regprocedure::text, p.prosecdef::text, p.provolatile, "
        "(p.prorettype = 'trigger'::regtype)::text, "
        "has_function_privilege('anon', p.oid, 'EXECUTE')::text, "
        "has_function_privilege('authenticated', p.oid, 'EXECUTE')::text "
        "from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1",
    )
    for sig, secdef, volatile, is_trigger, anon_exec, auth_exec in funcs:
        for role, has in (("anon", anon_exec), ("authenticated", auth_exec)):
            tgt = f"{sig}:{role}:EXECUTE"
            if truthy(has):
                add(
                    "function_grant_revoke",
                    "tighten",
                    tgt,
                    f"revoke execute on {sig} from {role}",
                    f"revoke execute on function {sig} from {role};",
                )
            else:
                add(
                    "function_grant_add",
                    "loosen",
                    tgt,
                    f"grant execute on {sig} to {role}",
                    f"grant execute on function {sig} to {role};",
                )
        if truthy(secdef):
            add(
                "function_definer_to_invoker",
                "tighten",
                sig,
                f"{sig}: security definer → invoker",
                f"alter function {sig} security invoker;",
            )
        elif not truthy(is_trigger) and volatile != "i":
            add(
                "function_invoker_to_definer",
                "loosen",
                sig,
                f"{sig}: security invoker → definer (runs as owner, bypasses RLS)",
                f"alter function {sig} security definer;",
            )

    # 6. Triggers (public + auth shim).
    trigs = db.query(
        dbname,
        "select n.nspname, c.relname, t.tgname from pg_trigger t "
        "join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace "
        "where not t.tgisinternal and n.nspname in ('public','auth') order by 1,2,3",
    )
    for schema, rel, tg in trigs:
        add(
            "trigger_drop",
            "loosen",
            f"{schema}.{rel}.{tg}",
            f"drop trigger {tg} on {schema}.{rel}",
            f"drop trigger {q(tg)} on {q(schema)}.{q(rel)};",
        )

    # 7. Payload-cap CHECK constraints (names end in bounds/size/length).
    checks = db.query(
        dbname,
        "select conrelid::regclass::text, conname from pg_constraint "
        "where contype='c' and connamespace='public'::regnamespace "
        "and conname ~ '(bounds|size|length)$' order by 1,2",
    )
    for rel, con in checks:
        add(
            "check_drop",
            "loosen",
            f"{rel}.{con}",
            f"drop constraint {con} on {rel}",
            f"alter table {rel} drop constraint {q(con)};",
        )

    # 8. Ledger owner NOT NULL.
    for rel in LEDGER_NOT_NULL_TABLES:
        add(
            "notnull_drop",
            "loosen",
            f"public.{rel}.user_id",
            f"drop not null on {rel}.user_id",
            f"alter table public.{q(rel)} alter column user_id drop not null;",
        )

    return muts


# ────────────────────────────── source mutants ─────────────────────────────


def split_statements(text: str) -> list[tuple[int, int]]:
    """Return [start, end) offsets of top-level statements, honouring --
    comments, 'strings', "idents" and $tag$ dollar quotes. ``end`` includes
    the terminating semicolon."""
    spans: list[tuple[int, int]] = []
    i, n = 0, len(text)
    start: int | None = None
    while i < n:
        ch = text[i]
        if text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if ch.isspace():
            i += 1
            continue
        if start is None:
            start = i
        if ch == "'":
            j = i + 1
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            continue
        if ch == '"':
            j = text.find('"', i + 1)
            i = n if j == -1 else j + 1
            continue
        if ch == "$":
            m = re.match(r"\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$", text[i:])
            if m:
                tag = m.group(0)
                j = text.find(tag, i + len(tag))
                i = n if j == -1 else j + len(tag)
                continue
        if ch == ";":
            spans.append((start, i + 1))
            start = None
        i += 1
    return spans


SECURITY_STMT_RE = re.compile(
    r"^(revoke\b|grant\b|create\s+policy\b|alter\s+policy\b|drop\s+policy\b|create\s+trigger\b|"
    r"alter\s+table\b.*\b(enable|force)\s+row\s+level\s+security|"
    r"alter\s+table\b.*\bset\s+not\s+null|"
    r"alter\s+table\b.*\badd\s+constraint\b)",
    re.IGNORECASE | re.DOTALL,
)

INNER_STMT_RE = re.compile(
    r"(?:create\s+policy\b|create\s+trigger\b|alter\s+table\b[^;]*?\badd\s+constraint\b)[^;]*;",
    re.IGNORECASE | re.DOTALL,
)


def strip_comments(s: str) -> str:
    return re.sub(r"--[^\n]*", "", s)


def line_of(text: str, off: int) -> int:
    return text.count("\n", 0, off) + 1


def generate_source() -> list[Mutant]:
    muts: list[Mutant] = []
    seq = 0
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        text = path.read_text()
        for start, end in split_statements(text):
            stmt = text[start:end]
            head = strip_comments(stmt).strip()
            spans: list[tuple[int, int, str]] = []
            if SECURITY_STMT_RE.match(head):
                spans.append((start, end, head))
            elif re.match(r"^do\b", head, re.IGNORECASE):
                for m in INNER_STMT_RE.finditer(stmt):
                    inner = m.group(0)
                    spans.append((start + m.start(), start + m.end(), strip_comments(inner).strip()))
            for s, e, shown in spans:
                seq += 1
                first = " ".join(shown.split())
                muts.append(
                    Mutant(
                        id=f"S{seq:04d}",
                        family="source",
                        category="source_delete",
                        direction="loosen",
                        target=f"{path.name}:{line_of(text, s)}",
                        description=f"delete statement: {first[:160]}",
                        source_file=path.name,
                        source_span=[s, e],
                        source_lines=[line_of(text, s), line_of(text, e - 1)],
                        removed_text=text[s:e],
                    )
                )
    return muts


# ───────────────────────────── scratch trees ───────────────────────────────


def make_scratch(scratch_root: Path, mutant: Mutant) -> tuple[Path, Path]:
    """Build <scratch_root>/<id>/supabase/{tests,migrations} with the mutant
    applied. Returns (supabase_dir, mutant_file_written)."""
    root = scratch_root / mutant.id / "supabase"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    shutil.copytree(TESTS_DIR, root / "tests", ignore=shutil.ignore_patterns("mutation"))
    shutil.copytree(MIGRATIONS_DIR, root / "migrations")
    if mutant.family == "endstate":
        mfile = root / "migrations" / f"{MUTANT_MIGRATION_PREFIX}{mutant.id}.sql"
        mfile.write_text(
            "-- MUTANT (scratch only, never commit): "
            f"{mutant.id} {mutant.category} {mutant.target}\n-- {mutant.description}\n{mutant.sql}\n"
        )
        return root, mfile
    src = root / "migrations" / mutant.source_file
    text = src.read_text()
    s, e = mutant.source_span
    if text[s:e] != mutant.removed_text:
        raise RuntimeError(f"{mutant.id}: migration text drifted; regenerate mutants")
    # Replace with same-length whitespace so line numbers in the log still map.
    replaced = re.sub(r"[^\n]", " ", text[s:e])
    src.write_text(text[:s] + replaced + text[e:])
    return root, src


# ───────────────────────────── classification ──────────────────────────────

CASE_RE = re.compile(r"^--\s*([A-Z]\d*[a-z]?):", re.MULTILINE)


def regression_case_index() -> list[tuple[int, str]]:
    """(line, case label) for every '-- X1:' marker in security_regression.sql."""
    out: list[tuple[int, str]] = []
    for i, line in enumerate(REGRESSION_SQL.read_text().splitlines(), start=1):
        m = CASE_RE.match(line)
        if m:
            out.append((i, m.group(1)))
    return out


def case_for_line(index: list[tuple[int, str]], line: int) -> str:
    label = "setup"
    for ln, case in index:
        if ln <= line:
            label = case
        else:
            break
    return label


ERR_RE = re.compile(r"^psql:(?P<file>[^:]+):(?P<line>\d+): ERROR:\s*(?P<msg>.*)$", re.MULTILINE)


def classify(exit_code: int, log: str, index: list[tuple[int, str]]) -> tuple[str, str, str, int]:
    """→ (verdict-ish, killed_by, killed_case, killed_line). SURVIVED here means
    exit 0; the caller upgrades to EQUIVALENT via the snapshot diff."""
    if exit_code == 0 and "SECURITY REGRESSION MATRIX: ALL CASES PASSED" in log:
        return "SURVIVED", "", "", 0
    m = ERR_RE.search(log)
    if m:
        file, line, msg = m.group("file"), int(m.group("line")), m.group("msg").strip()
        if file.endswith("security_regression.sql"):
            # plpgsql error text; a following CONTEXT line is not needed.
            return "KILLED", msg, case_for_line(index, line), line
        return "INVALID", f"{file}:{line}: {msg}", "", line
    if "did not become ready" in log or "docker" in log.lower():
        return "INFRA", log.strip().splitlines()[-1] if log.strip() else "", "", 0
    return "INFRA", (log.strip().splitlines() or [""])[-1], "", 0


# ────────────────────────────────── run ────────────────────────────────────


def run_rls(supabase_dir: Path) -> tuple[int, str, float]:
    t0 = time.monotonic()
    r = subprocess.run(
        ["bash", str(supabase_dir / "tests" / "run_rls_tests.sh")],
        text=True,
        capture_output=True,
        cwd=str(supabase_dir),
    )
    return r.returncode, r.stdout + r.stderr, time.monotonic() - t0


def load_mutants(path: Path) -> list[Mutant]:
    return [Mutant(**m) for m in json.loads(path.read_text())]


def cmd_generate(out_dir: Path, db: SnapshotDb) -> tuple[list[Mutant], list[str]]:
    dbname, failed = db.build(MIGRATIONS_DIR)
    if failed is not None:
        raise RuntimeError(f"baseline migrations failed to apply:\n{failed.stdout}\n{failed.stderr}")
    base_snap = snapshot(db, dbname)
    mutants = generate_endstate(db, dbname) + generate_source()
    db.drop(dbname)
    (out_dir / "mutants.json").write_text(json.dumps([asdict(m) for m in mutants], indent=2))
    (out_dir / "baseline_snapshot.txt").write_text("\n".join(base_snap) + "\n")
    return mutants, base_snap


def select_mutants(
    mutants: list[Mutant], ids: str | None, families: str | None, categories: str | None
) -> list[Mutant]:
    sel = mutants
    if ids:
        want = {x.strip() for x in ids.split(",") if x.strip()}
        sel = [m for m in sel if m.id in want]
    if families:
        want = {x.strip() for x in families.split(",")}
        sel = [m for m in sel if m.family in want]
    if categories:
        want = {x.strip() for x in categories.split(",")}
        sel = [m for m in sel if m.category in want]
    return sel


def cmd_run(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    logs_dir = out_dir / "logs"
    logs_dir.mkdir(exist_ok=True)
    scratch_root = out_dir / "scratch"
    if not docker_available():
        print("Docker is required (same prerequisite as run_rls_tests.sh); refusing to run.", file=sys.stderr)
        return 2

    index = regression_case_index()
    results: list[Result] = []
    started = dt.datetime.now(dt.timezone.utc).isoformat()

    with SnapshotDb() as db:
        mutants_path = out_dir / "mutants.json"
        if mutants_path.exists() and not args.regenerate:
            mutants = load_mutants(mutants_path)
            base_snap = (out_dir / "baseline_snapshot.txt").read_text().splitlines()
        else:
            mutants, base_snap = cmd_generate(out_dir, db)
        selected = select_mutants(mutants, args.ids, args.families, args.categories)
        print(f"{len(selected)}/{len(mutants)} mutants selected; out-dir {out_dir}")

        # Baseline gate: the unmodified tree must pass or every verdict is meaningless.
        code, log, dur = run_rls(SUPABASE_DIR)
        (logs_dir / "baseline.log").write_text(log)
        if code != 0:
            print(f"BASELINE FAILED (exit {code}); see {logs_dir / 'baseline.log'}", file=sys.stderr)
            return 3
        print(f"baseline: exit 0 in {dur:.1f}s")

        for i, m in enumerate(selected, start=1):
            supabase_dir, mfile = make_scratch(scratch_root, m)
            code, log, dur = run_rls(supabase_dir)
            log_path = logs_dir / f"{m.id}.log"
            log_path.write_text(log)
            verdict, killed_by, killed_case, killed_line = classify(code, log, index)
            res = Result(
                id=m.id,
                verdict=verdict,
                exit_code=code,
                duration_s=round(dur, 2),
                killed_by=killed_by,
                killed_case=killed_case,
                killed_line=killed_line,
                log=str(log_path.relative_to(out_dir)),
                mutant_migration=str(mfile.relative_to(out_dir)),
            )
            if verdict == "SURVIVED":
                # Equivalence check: does the mutant change the security catalog at all?
                dbname, failed = db.build(supabase_dir / "migrations")
                if failed is not None:
                    res.note = "snapshot build failed: " + (failed.stderr or failed.stdout).strip()[-400:]
                else:
                    snap = snapshot(db, dbname)
                    diff = sorted(set(snap) ^ set(base_snap))
                    res.snapshot_diff_lines = len(diff)
                    res.snapshot_diff_sample = diff[:12]
                    if not diff:
                        res.verdict = "EQUIVALENT"
                db.drop(dbname)
            results.append(res)
            tag = res.killed_case if res.verdict == "KILLED" else ""
            print(f"[{i}/{len(selected)}] {m.id} {res.verdict:<10} {tag:<6} {m.category:<28} {m.target}")
            if not args.keep_scratch:
                shutil.rmtree(scratch_root / m.id, ignore_errors=True)
            (out_dir / "results.json").write_text(
                json.dumps(
                    {
                        "started": started,
                        "git_head": git_head(),
                        "selection": {"ids": args.ids, "families": args.families, "categories": args.categories},
                        "results": [asdict(r) for r in results],
                    },
                    indent=2,
                )
            )

    write_report(out_dir, mutants, results)
    survivors = [r for r in results if r.verdict == "SURVIVED"]
    print(
        f"done: {len(results)} run, {sum(r.verdict == 'KILLED' for r in results)} killed, "
        f"{len(survivors)} survived, {sum(r.verdict == 'EQUIVALENT' for r in results)} equivalent, "
        f"{sum(r.verdict == 'INVALID' for r in results)} invalid, "
        f"{sum(r.verdict == 'INFRA' for r in results)} infra"
    )
    return 1 if survivors else 0


def git_head() -> str:
    r = sh(["git", "-C", str(SUPABASE_DIR), "rev-parse", "HEAD"])
    return r.stdout.strip() if r.returncode == 0 else ""


# ──────────────────────────────── report ───────────────────────────────────


def write_report(out_dir: Path, mutants: list[Mutant], results: list[Result]) -> None:
    by_id = {m.id: m for m in mutants}
    lines = ["# RLS / grant mutation report", ""]
    total = len(results)
    counts: dict[str, int] = {}
    for r in results:
        counts[r.verdict] = counts.get(r.verdict, 0) + 1
    lines.append(f"mutants run: {total}  " + "  ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    lines.append("")
    # per-category matrix
    cats: dict[str, dict[str, int]] = {}
    for r in results:
        c = cats.setdefault(by_id[r.id].category, {})
        c[r.verdict] = c.get(r.verdict, 0) + 1
    lines += [
        "## Per-category matrix",
        "",
        "| category | direction | KILLED | SURVIVED | EQUIVALENT | INVALID | INFRA |",
        "|---|---|---|---|---|---|---|",
    ]
    for cat in sorted(cats):
        c = cats[cat]
        direction = next(m.direction for m in mutants if m.category == cat)
        lines.append(
            f"| {cat} | {direction} | {c.get('KILLED', 0)} | {c.get('SURVIVED', 0)} | "
            f"{c.get('EQUIVALENT', 0)} | {c.get('INVALID', 0)} | {c.get('INFRA', 0)} |"
        )
    lines += ["", "## Survivors (coverage gaps)", ""]
    surv = [r for r in results if r.verdict == "SURVIVED"]
    if not surv:
        lines.append("none")
    else:
        lines += ["| id | category | target | mutation | catalog Δ lines |", "|---|---|---|---|---|"]
        for r in surv:
            m = by_id[r.id]
            lines.append(f"| {r.id} | {m.category} | `{m.target}` | {m.description} | {r.snapshot_diff_lines} |")
    lines += ["", "## Equivalent mutants (no catalog change)", ""]
    eq = [r for r in results if r.verdict == "EQUIVALENT"]
    if not eq:
        lines.append("none")
    else:
        lines += ["| id | target | mutation |", "|---|---|---|"]
        for r in eq:
            m = by_id[r.id]
            lines.append(f"| {r.id} | `{m.target}` | {m.description} |")
    lines += ["", "## Invalid / infra", ""]
    bad = [r for r in results if r.verdict in ("INVALID", "INFRA")]
    if not bad:
        lines.append("none")
    else:
        for r in bad:
            lines.append(f"- {r.id} {r.verdict}: {r.killed_by}")
    lines += [
        "",
        "## All mutants",
        "",
        "| id | verdict | killed by case | category | target | exit | s |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in results:
        m = by_id[r.id]
        lines.append(
            f"| {r.id} | {r.verdict} | {r.killed_case} | {m.category} | `{m.target}` | {r.exit_code} | {r.duration_s} |"
        )
    (out_dir / "report.md").write_text("\n".join(lines) + "\n")


def cmd_report(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    mutants = load_mutants(out_dir / "mutants.json")
    data = json.loads((out_dir / "results.json").read_text())
    results = [Result(**r) for r in data["results"]]
    write_report(out_dir, mutants, results)
    print(out_dir / "report.md")
    return 0


def cmd_generate_only(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if not docker_available():
        print("Docker is required to enumerate the catalog.", file=sys.stderr)
        return 2
    with SnapshotDb() as db:
        mutants, _ = cmd_generate(out_dir, db)
    print(f"{len(mutants)} mutants → {out_dir / 'mutants.json'}")
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("run", cmd_run), ("generate", cmd_generate_only), ("report", cmd_report)):
        sp = sub.add_parser(name)
        sp.add_argument("--out-dir", required=True, help="artifact directory (scratch trees, logs, JSON, report)")
        if name == "run":
            sp.add_argument("--ids", help="comma-separated mutant ids to (re)run")
            sp.add_argument("--families", help="comma-separated: endstate,source")
            sp.add_argument("--categories", help="comma-separated category filter")
            sp.add_argument(
                "--regenerate", action="store_true", help="re-enumerate mutants even if mutants.json exists"
            )
            sp.add_argument(
                "--keep-scratch", action="store_true", help="keep every scratch tree (default: delete after run)"
            )
        sp.set_defaults(fn=fn)
    args = p.parse_args(list(argv) if argv is not None else None)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
