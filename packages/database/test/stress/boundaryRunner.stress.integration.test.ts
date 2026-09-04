import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  MIGRATION_LOCK_KEY,
  checksumOf,
  orderMigrations,
  runMigrations,
} from "../../src/migrate.js";
import {
  CONTROL_STRINGS,
  KB64,
  NUMERIC_EDGE_TEXT,
  Reporter,
  Rng,
  TEST_URL,
  UNICODE_PAIRS,
  assertSafeIdent,
  campaignSeeds,
  classifyError,
  describeInput,
  formatAnomalies,
  graphemeBomb,
  iterations,
  schemaPool,
  trimMessage,
  type Outcome,
} from "./harness.js";

/**
 * LENS boundary-malformed / campaign "runner": `runMigrations` fed generated
 * migration directories whose files are malformed (truncated SQL, null bytes,
 * invalid UTF-8, runtime errors, statements that cannot run in a transaction,
 * explicit COMMIT, 64 KiB+ comments, hostile identifiers, directory entries,
 * symlinks, skipped names). Invariants checked after EVERY run:
 *
 *   - the runner either resolves or throws an `Error` naming the migration;
 *   - a failed file leaves no `schema_migrations` row and none of its DDL;
 *   - files ordered after the failure are untouched;
 *   - files before it are fully applied with the right checksum;
 *   - the advisory lock is released and a follow-up run neither deadlocks
 *     nor re-applies anything;
 *   - the pool is still usable.
 *
 * Default 40 directories; STRESS_ITER scales it (x0.1).
 */

type FileKind =
  | "valid"
  | "empty"
  | "whitespace"
  | "comment-only"
  | "truncated"
  | "null-byte"
  | "invalid-utf8"
  | "runtime-error"
  | "syntax-error"
  | "non-transactional"
  | "explicit-commit"
  | "huge-comment"
  | "huge-statement"
  | "unicode-ident"
  | "placeholder"
  | "do-block-raise"
  | "self-referential"
  | "skipped-name"
  | "directory-entry"
  | "symlink"
  | "future-number";

interface GeneratedFile {
  name: string;
  kind: FileKind;
  bytes: Buffer;
  /** Relations the file creates when it runs to completion. */
  tables: string[];
  /** Whether the runner is expected to reject this file. "maybe" = truncated. */
  failure: boolean | "maybe";
  /** Path this entry symlinks to (kind === "symlink"). */
  linkTarget?: string;
  isDirectory?: boolean;
}

const migrationName = (n: number, slug: string) => `${String(n).padStart(4, "0")}_${slug}.sql`;

function generateFile(rng: Rng, n: number, schema: string): GeneratedFile {
  const t = `t_${rng.hex(6)}`;
  const t2 = `t_${rng.hex(6)}`;
  const ddl = `CREATE TABLE ${t} (id integer PRIMARY KEY, note text NOT NULL DEFAULT '');\nINSERT INTO ${t} (id) VALUES (1);\n`;
  const kinds: FileKind[] = [
    "valid",
    "valid",
    "valid",
    "empty",
    "whitespace",
    "comment-only",
    "truncated",
    "truncated",
    "null-byte",
    "invalid-utf8",
    "runtime-error",
    "syntax-error",
    "non-transactional",
    "explicit-commit",
    "huge-comment",
    "huge-statement",
    "unicode-ident",
    "placeholder",
    "do-block-raise",
    "self-referential",
    "skipped-name",
    "directory-entry",
    "symlink",
    "future-number",
  ];
  const kind = rng.pick(kinds);
  const name = migrationName(n, `${kind.replace(/-/g, "_")}_${rng.hex(3)}`);
  const base = { name, kind, tables: [t], failure: false as boolean | "maybe" };

  switch (kind) {
    case "valid":
      return { ...base, bytes: Buffer.from(ddl) };
    case "empty":
      return { ...base, bytes: Buffer.alloc(0), tables: [] };
    case "whitespace":
      return {
        ...base,
        bytes: Buffer.from(rng.pick([" ", "\n\n", "\t\r\n", "\u00a0"])),
        tables: [],
      };
    case "comment-only":
      return {
        ...base,
        bytes: Buffer.from(
          `-- ${rng.pick(CONTROL_STRINGS).replace(/\n|\r/g, " ")}\n/* ${rng.pick(NUMERIC_EDGE_TEXT)} */\n`,
        ),
        tables: [],
      };
    case "truncated": {
      const cut = rng.int(1, ddl.length - 1);
      const sql = ddl.slice(0, cut);
      // A cut inside the INSERT still leaves a complete CREATE TABLE behind
      // the first ';' — the table exists only if the whole file succeeds.
      return { ...base, bytes: Buffer.from(sql), failure: "maybe" };
    }
    case "null-byte": {
      const where = rng.int(0, 2);
      const sql =
        where === 0
          ? `\u0000${ddl}`
          : where === 1
            ? `${ddl.slice(0, ddl.indexOf(";") + 1)}\u0000${ddl.slice(ddl.indexOf(";") + 1)}`
            : `${ddl}\u0000`;
      return { ...base, bytes: Buffer.from(sql), failure: "maybe" };
    }
    case "invalid-utf8": {
      const head = Buffer.from(`CREATE TABLE ${t} (id integer, label text NOT NULL DEFAULT '`);
      const tail = Buffer.from(`');\nINSERT INTO ${t} (id) VALUES (1);\n`);
      const junk = Buffer.from(rng.pick([[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf8, 0x88]]));
      return { ...base, bytes: Buffer.concat([head, junk, tail]), failure: "maybe" };
    }
    case "runtime-error":
      return {
        ...base,
        bytes: Buffer.from(
          `${ddl}ALTER TABLE ${t} ADD CONSTRAINT ${t}_pos CHECK (id > 0);\nINSERT INTO ${t} (id) VALUES (${rng.pick(["-1", "1", "0", "NULL", "'x'", "2147483648"])});\n`,
        ),
        failure: "maybe",
      };
    case "syntax-error":
      return {
        ...base,
        bytes: Buffer.from(
          `${ddl}${rng.pick(["CREATE TABEL", "SELEC 1", "INSERT INTO", ")", "'", '"', "$$", "\\"])}\n`,
        ),
        failure: true,
      };
    case "non-transactional":
      return {
        ...base,
        bytes: Buffer.from(
          `${ddl}${rng.pick([
            `CREATE INDEX CONCURRENTLY ${t}_idx ON ${t} (note);`,
            `VACUUM ${t};`,
            `CREATE DATABASE ${t};`,
            `ALTER TYPE pg_catalog.text ADD VALUE 'x';`,
          ])}\n`,
        ),
        failure: true,
      };
    case "explicit-commit":
      return {
        ...base,
        bytes: Buffer.from(
          `${ddl}COMMIT;\nCREATE TABLE ${t2} (id integer);\nINSERT INTO ${t2} VALUES ('not an int');\n`,
        ),
        tables: [t, t2],
        failure: true,
      };
    case "huge-comment":
      return {
        ...base,
        bytes: Buffer.from(
          `-- ${"x".repeat(KB64 + rng.int(0, KB64))}\n/* ${graphemeBomb(3000)} */\n${ddl}`,
        ),
      };
    case "huge-statement": {
      const rows = Array.from({ length: rng.int(2000, 6000) }, (_, i) => `(${i + 2})`).join(",");
      return { ...base, bytes: Buffer.from(`${ddl}INSERT INTO ${t} (id) VALUES ${rows};\n`) };
    }
    case "unicode-ident": {
      const pair = rng.pick(UNICODE_PAIRS);
      const ident = `t_${pair[rng.int(1, 2) as 1 | 2]}_${rng.hex(4)}`;
      return {
        ...base,
        bytes: Buffer.from(
          `CREATE TABLE "${ident}" ("${rng.pick(["ﬁeld", "field", "𝕗", "f\u0301"])}" text);\n`,
        ),
        tables: [ident],
      };
    }
    case "placeholder":
      return { ...base, bytes: Buffer.from(`${ddl}SELECT $1;\n`), failure: true };
    case "do-block-raise":
      return {
        ...base,
        bytes: Buffer.from(
          `${ddl}DO $$ BEGIN RAISE EXCEPTION 'generated failure %', ${rng.int(0, 1e9)}; END $$;\n`,
        ),
        failure: true,
      };
    case "self-referential":
      // A migration that tampers with the ledger itself. Observation only.
      return {
        ...base,
        bytes: Buffer.from(
          `${ddl}UPDATE schema_migrations SET checksum = 'tampered' WHERE name <> '${name}';\n`,
        ),
      };
    case "skipped-name":
      return {
        ...base,
        name: rng.pick([
          `${String(n).padStart(4, "0")}_Upper.sql`,
          `${String(n).padStart(4, "0")}_x.sql.bak`,
          `${String(n).padStart(4, "0")}-dash.sql`,
          `${String(n).padStart(3, "0")}_short.sql`,
          `${String(n).padStart(4, "0")}_x.SQL`,
          `.${String(n).padStart(4, "0")}_hidden.sql`,
          `${String(n).padStart(4, "0")}_é.sql`,
          `${String(n).padStart(4, "0")}_x .sql`,
        ]),
        bytes: Buffer.from(ddl),
      };
    case "directory-entry":
      return { ...base, bytes: Buffer.alloc(0), tables: [], isDirectory: true, failure: true };
    case "symlink":
      return { ...base, bytes: Buffer.from(ddl), linkTarget: `../outside_${schema}_${n}.sql` };
    case "future-number":
      return {
        ...base,
        name: migrationName(9000 + rng.int(0, 999), `future_${rng.hex(3)}`),
        bytes: Buffer.from(ddl),
      };
  }
}

interface RunResult {
  outcome: Outcome;
  sqlstate?: string;
  message?: string;
  applied: string[];
  failedName?: string;
}

async function runOnce(pool: pg.Pool, dir: string): Promise<RunResult> {
  try {
    const { applied } = await runMigrations(pool, dir);
    return { outcome: "ACCEPTED", applied };
  } catch (error) {
    if (!(error instanceof Error)) {
      return { outcome: "ANOMALY_UNTYPED", message: trimMessage(String(error)), applied: [] };
    }
    const match = /^Migration (\S+) failed: /.exec(error.message);
    const cause = error.cause ?? error;
    const classified = classifyError(cause);
    const outcome: Outcome =
      classified.outcome === "ANOMALY_INTERNAL" ? "ANOMALY_INTERNAL" : "REJECTED_TYPED";
    return {
      outcome,
      ...(classified.sqlstate ? { sqlstate: classified.sqlstate } : {}),
      message: trimMessage(error.message),
      applied: [],
      ...(match ? { failedName: match[1] as string } : {}),
    };
  }
}

describe.skipIf(!TEST_URL)(
  "stress/boundary-malformed: runMigrations vs generated directories",
  () => {
    const admin = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    const total = iterations(60, 0.1);
    const root = mkdtempSync(join(tmpdir(), "pickle-stress-runner-"));

    beforeAll(async () => {
      await admin.query("SELECT 1");
    });

    afterAll(async () => {
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    });

    it(`keeps every migration atomic and the ledger honest (${total} directories)`, async () => {
      const reporter = new Reporter("runner-malformed-dirs", { iterations: total });

      for (const [index, seed] of campaignSeeds("runner", total).entries()) {
        const rng = new Rng(seed);
        const schema = `stress_run_${seed.toString(16)}`;
        assertSafeIdent(schema);
        const dir = join(root, schema);
        mkdirSync(dir);
        const files = Array.from({ length: rng.int(1, 5) }, (_, i) =>
          generateFile(rng, i + 1, schema),
        );
        for (const f of files) {
          const path = join(dir, f.name);
          if (f.isDirectory) mkdirSync(path);
          else if (f.linkTarget) {
            writeFileSync(join(dir, f.linkTarget), f.bytes);
            symlinkSync(f.linkTarget, path);
          } else writeFileSync(path, f.bytes);
        }
        const summary = files.map((f) => `${f.name}:${f.kind}`);
        const started = performance.now();

        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.query(`CREATE SCHEMA ${schema}`);
        const pool = schemaPool(schema);
        const problems: string[] = [];
        const notes: string[] = [];
        let outcome: Outcome = "ACCEPTED";
        let sqlstate: string | undefined;
        let message: string | undefined;

        try {
          const first = await runOnce(pool, dir);
          outcome = first.outcome;
          sqlstate = first.sqlstate;
          message = first.message;

          const ordered = orderMigrations(files.map((f) => f.name));
          const failedIdx = first.failedName ? ordered.indexOf(first.failedName) : -1;
          const byName = new Map(files.map((f) => [f.name, f]));

          if (
            first.outcome === "REJECTED_TYPED" &&
            !first.failedName &&
            !/checksum/.test(first.message ?? "")
          ) {
            // Loader-level rejection (EISDIR etc.) — must have applied nothing.
            const anyDir = files.some((f) => f.isDirectory);
            if (!anyDir) problems.push("rejection-without-migration-name");
            notes.push("loader-rejection");
          }

          const ledger = await pool
            .query<{ name: string; checksum: string }>(
              "SELECT name, checksum FROM schema_migrations ORDER BY name",
            )
            .catch(() => ({ rows: [] as { name: string; checksum: string }[] }));
          const ledgerByName = new Map(ledger.rows.map((r) => [r.name, r.checksum]));
          const relations = new Set(
            (
              await pool.query<{ relname: string }>(
                "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'",
                [schema],
              )
            ).rows.map((r) => r.relname),
          );

          for (const name of ordered) {
            const f = byName.get(name);
            if (!f) continue;
            const idx = ordered.indexOf(name);
            const shouldBeApplied =
              failedIdx === -1 ? first.outcome === "ACCEPTED" : idx < failedIdx;
            const inLedger = ledgerByName.has(name);
            const tablesPresent = f.tables.filter((t) => relations.has(t));
            if (shouldBeApplied) {
              if (!inLedger) problems.push(`applied-but-not-in-ledger:${name}`);
              else if (
                f.kind !== "self-referential" &&
                !files.some((g) => g.kind === "self-referential")
              ) {
                const expected = checksumOf(f.bytes.toString("utf8"));
                if (ledgerByName.get(name) !== expected) problems.push(`checksum-mismatch:${name}`);
              }
              if (tablesPresent.length !== f.tables.length)
                problems.push(`applied-but-ddl-missing:${name}`);
            } else {
              if (inLedger) problems.push(`failed-but-in-ledger:${name}`);
              if (tablesPresent.length > 0) {
                if (f.kind === "explicit-commit") {
                  notes.push(`partial-write-via-COMMIT:${name}:${tablesPresent.join(",")}`);
                  outcome = "ANOMALY_WRITE";
                } else {
                  problems.push(`failed-but-ddl-present:${name}:${tablesPresent.join(",")}`);
                }
              }
            }
          }
          for (const f of files) {
            if (!ordered.includes(f.name)) {
              if (ledgerByName.has(f.name)) problems.push(`skipped-name-in-ledger:${f.name}`);
              if (f.tables.some((t) => relations.has(t)))
                problems.push(`skipped-name-ran:${f.name}`);
            }
          }
          if (files.some((f) => f.kind === "self-referential")) {
            if ([...ledgerByName.values()].includes("tampered"))
              notes.push("ledger-writable-by-migration");
          }

          // Lock released + follow-up run terminates and is idempotent.
          const locks = await pool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1",
            [MIGRATION_LOCK_KEY],
          );
          if (locks.rows[0]?.n !== "0") problems.push(`advisory-lock-leaked:${locks.rows[0]?.n}`);

          const second = await Promise.race([
            runOnce(pool, dir),
            new Promise<RunResult>((_, reject) =>
              setTimeout(() => reject(new Error("second run hung >15s")), 15_000),
            ),
          ]);
          if (second.applied.length > 0)
            problems.push(`rerun-reapplied:${second.applied.join(",")}`);
          if (second.outcome === "ACCEPTED" && first.outcome !== "ACCEPTED") {
            // Retrying a failed directory can only succeed if the failing file
            // is non-deterministic; a partial COMMIT makes the retry fail
            // differently ("already exists") — both get recorded.
            notes.push("rerun-succeeded-after-failure");
          }
          if (second.sqlstate === "42P07")
            notes.push(`rerun-wedged-42P07:${second.failedName ?? "?"}`);
          if (second.outcome.startsWith("ANOMALY"))
            problems.push(`rerun:${second.outcome}:${second.message}`);

          const health = await pool.query<{ ok: number }>("SELECT 1 AS ok");
          if (health.rows[0]?.ok !== 1) problems.push("pool-unhealthy");
        } catch (error) {
          problems.push(`harness-threw:${trimMessage(String(error))}`);
        } finally {
          await pool
            .end()
            .catch((e: unknown) => problems.push(`pool-end:${trimMessage(String(e))}`));
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          rmSync(dir, { recursive: true, force: true });
        }

        if (problems.length > 0 && !outcome.startsWith("ANOMALY")) outcome = "ANOMALY_PROPERTY";
        reporter.add({
          seed,
          index,
          kind: files.map((f) => f.kind).join("+"),
          input: describeInput(summary, 400),
          outcome,
          ...(sqlstate ? { sqlstate } : {}),
          ...(message ? { message } : {}),
          ...(problems.length || notes.length ? { note: [...problems, ...notes].join(";") } : {}),
          durationMs: performance.now() - started,
        });
      }

      // Known finding (pinned by the `it.fails` case below): a file containing
      // an explicit COMMIT escapes the per-migration transaction. Those rows stay
      // in the JSON table as ANOMALY_WRITE but are not re-asserted here so the
      // campaign keeps guarding every OTHER atomicity property.
      const knownCommitEscapes = reporter
        .anomalies()
        .filter(
          (r) => r.outcome === "ANOMALY_WRITE" && /^partial-write-via-COMMIT:/.test(r.note ?? ""),
        );
      reporter.meta["knownFinding_explicitCommitPartialWrite"] = knownCommitEscapes.map(
        (r) => r.seed,
      );
      const path = reporter.write();
      console.warn(
        `[stress] runner-malformed-dirs: ${JSON.stringify(reporter.summary())} → ${path}`,
      );
      const unexplained = new Reporter(reporter.campaign);
      for (const row of reporter.anomalies()) {
        if (!knownCommitEscapes.includes(row)) unexplained.add(row);
      }
      expect(reporter.rows.length).toBe(total);
      expect(formatAnomalies(unexplained)).toBe("");
    });

    /**
     * FINDING (P2): `runMigrations` wraps `client.query(file.sql)` in
     * BEGIN/COMMIT but does not reject transaction-control statements inside
     * the file. A file with `COMMIT;` followed by a failing statement leaves the
     * DDL before the COMMIT applied, records nothing in `schema_migrations`, and
     * the retry then fails with 42P07 "already exists" — the deployment is
     * wedged until someone hand-edits the database. `it.fails` pins the CURRENT
     * behaviour: this test starts failing (i.e. the bug is fixed) the moment the
     * runner guards against it.
     */
    it.fails(
      "a failed migration containing COMMIT leaves no DDL behind (currently broken)",
      async () => {
        const schema = "stress_run_commit_repro";
        const dir = join(root, schema);
        mkdirSync(dir);
        writeFileSync(
          join(dir, "0001_commit_escape.sql"),
          "CREATE TABLE t_before (id integer);\nCOMMIT;\nCREATE TABLE t_after (id integer);\nINSERT INTO t_after VALUES ('not an int');\n",
        );
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.query(`CREATE SCHEMA ${schema}`);
        const pool = schemaPool(schema);
        try {
          await expect(runMigrations(pool, dir)).rejects.toThrow(/0001_commit_escape\.sql failed/);
          const ledger = await pool.query("SELECT name FROM schema_migrations");
          expect(ledger.rows).toEqual([]);
          const leaked = await pool.query<{ relname: string }>(
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname LIKE 't_%'",
            [schema],
          );
          // The invariant the runner promises ("each migration runs in its own
          // transaction"): nothing from a failed file survives.
          expect(leaked.rows.map((r) => r.relname)).toEqual([]);
        } finally {
          await pool.end();
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
      },
    );
  },
);
