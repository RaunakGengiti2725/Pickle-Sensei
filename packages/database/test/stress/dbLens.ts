import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";
import { getAllShotScoringConfigs } from "@pickle/scoring";
import {
  checksumOf,
  loadMigrations,
  orderMigrations,
  runMigrations,
  type MigrationFile,
} from "../../src/migrate.js";
import { SEEDED_FEATURE_FLAGS, seed as runSeed } from "../../src/seed.js";
import { Rng } from "./rng.js";

/**
 * DB lens: seeded random sequences of legal / near-legal operations over the
 * public API of @pickle/database (runMigrations + seed) against a real
 * PostgreSQL, with the model checked after EVERY step.
 *
 * Invariants (from migrate.ts / seed.ts doc comments and the pinning tests):
 *   M1  schema_migrations == exactly the files the runner reported applied,
 *       with the on-disk checksum; names unique.
 *   M2  runMigrations(dir) applies exactly the legal, not-yet-applied files
 *       of dir in sorted order and skips the rest; a second run is a no-op.
 *   M3  A tampered already-applied file is refused (checksum mismatch) and
 *       nothing after it is applied.
 *   M4  A failing migration leaves no trace: its objects are rolled back, it
 *       is not recorded, later files are not applied, earlier files are.
 *   M5  Concurrent runners apply every migration exactly once.
 *   M6  A runner whose connections are terminated / whose pool is ended
 *       mid-run leaves schema_migrations consistent (every recorded row has
 *       the on-disk checksum) and a subsequent run completes the chain.
 *   C1  A runner whose connections are terminated mid-run settles as a
 *       rejected promise (catchable by cli.ts) instead of crashing the
 *       process. Checked in a child process (test/stress/victim.ts) so that a
 *       crash is observed rather than suffered. Whether the kill lands before
 *       or after completion is timing-dependent, so C1 failures do not stop
 *       the sequence and are excluded from the D1 trace key.
 *   S1  seed is idempotent and yields the catalog counts pinned in
 *       migrate.test.ts (8 shot types, 11 checkpoints, one validating model
 *       per scoring config, 7 achievements, 18 seeded flags, exactly two
 *       active offerings).
 *   S2  seed never rewrites a released (active) or retired model: config,
 *       thresholds, checkpoints and targets are frozen.
 *   S3  seed re-establishes catalog rows that were mutated while pre-release
 *       (validating model config/checkpoint weights/targets, offering
 *       price/active, rogue offerings deactivated, fixture drills retired) and
 *       preserves operator-owned feature-flag values (ON CONFLICT DO NOTHING).
 *   N1  No NaN / Infinity in any numeric scoring column after seed for
 *       pre-release models.
 *   D1  Same seed => identical (normalized) trace.
 *
 * Observed-but-not-asserted behaviours are counted in `observations` so the
 * campaign table can surface them without failing the suite.
 */

export type DbActionKind =
  | "migrate_full"
  | "migrate_partial"
  | "migrate_twice"
  | "seed"
  | "seed_concurrent"
  | "migrate_concurrent"
  | "promote_model"
  | "retire_model"
  | "tamper_validating_model"
  | "flip_flag"
  | "delete_flag"
  | "rogue_offering"
  | "mutate_seeded_offering"
  | "fixture_drill"
  | "tamper_applied_file"
  | "add_extra_migration"
  | "add_failing_migration"
  | "add_malformed_name"
  | "kill_mid_migration"
  | "end_pool_mid_migration"
  | "reset_schema";

export interface DbActionSpec {
  kind: DbActionKind;
  r: [number, number, number];
}

const DB_WEIGHTS: ReadonlyArray<readonly [DbActionKind, number]> = [
  ["migrate_full", 16],
  ["migrate_partial", 9],
  ["migrate_twice", 4],
  ["seed", 18],
  ["seed_concurrent", 3],
  ["migrate_concurrent", 4],
  ["promote_model", 4],
  ["retire_model", 2],
  ["tamper_validating_model", 5],
  ["flip_flag", 4],
  ["delete_flag", 2],
  ["rogue_offering", 3],
  ["mutate_seeded_offering", 3],
  ["fixture_drill", 2],
  ["tamper_applied_file", 4],
  ["add_extra_migration", 4],
  ["add_failing_migration", 3],
  ["add_malformed_name", 2],
  ["kill_mid_migration", 3],
  ["end_pool_mid_migration", 2],
  ["reset_schema", 2],
];

export function generateDbSequence(
  seed: number,
  minLen = 5,
  maxLen = 60,
): { length: number; actions: DbActionSpec[] } {
  const rng = new Rng(seed);
  const length = rng.int(minLen, maxLen);
  const actions: DbActionSpec[] = [];
  for (let i = 0; i < length; i++) {
    actions.push({ kind: rng.weighted(DB_WEIGHTS), r: [rng.next(), rng.next(), rng.next()] });
  }
  return { length, actions };
}

export interface DbFailure {
  step: number;
  kind: DbActionKind;
  invariant: string;
  detail: string;
}

export interface DbStep {
  i: number;
  kind: DbActionKind;
  outcome: Record<string, unknown>;
}

export interface DbSequenceResult {
  lens: "db";
  seed: number;
  length: number;
  executedSteps: number;
  status: "HELD" | "BROKEN";
  failures: DbFailure[];
  observations: Record<string, number>;
  trace: DbStep[];
  durationMs: number;
}

export interface DbContext {
  connectionString: string;
  pool: pg.Pool;
  canonical: MigrationFile[];
  /** Non-deterministic-timing budget for kill/end actions (ms). */
  killDelayMs?: number;
}

const VICTIM_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "victim.ts");

export interface VictimExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Spawns victim.ts (runMigrations in a fresh node process) and resolves on exit. */
export function spawnVictim(
  connectionString: string,
  dir: string,
  appName: string,
): { exited: () => boolean; done: Promise<VictimExit>; kill: () => void } {
  let exited = false;
  let kill: () => void = () => undefined;
  const done = new Promise<VictimExit>((resolve) => {
    const child = execFile(
      process.execPath,
      ["--import", "tsx", VICTIM_SCRIPT, connectionString, dir, appName],
      { cwd: dirname(VICTIM_SCRIPT), env: process.env, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        exited = true;
        if (error === null) resolve({ code: 0, signal: null, stdout, stderr });
        else
          resolve({
            code: typeof error.code === "number" ? error.code : null,
            signal: error.signal ?? null,
            stdout,
            stderr: stderr || error.message,
          });
      },
    );
    kill = () => {
      child.kill("SIGKILL");
    };
  });
  return { exited: () => exited, done, kill: () => kill() };
}

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

export async function createDbContext(connectionString: string): Promise<DbContext> {
  const pool = new pg.Pool({ connectionString, max: 4 });
  pool.on("error", () => {
    // Idle-client errors (e.g. after pg_terminate_backend) must not crash the
    // harness; counted per action through the victim pools instead.
  });
  const canonical = await loadMigrations(MIGRATIONS_DIR);
  return { connectionString, pool, canonical };
}

const SEEDED_OFFERINGS: ReadonlyArray<readonly [string, number]> = [
  ["premium_monthly_499", 499],
  ["premium_annual_3999", 3999],
];
const ACHIEVEMENT_COUNT = 7;

interface ModelSnapshot {
  config: string;
  status: string;
  minConf: string;
  lowerConf: string;
  checkpoints: number;
  targets: number;
  weightSum: string;
}

interface OfferingExpectation {
  active: boolean;
  price: number | null;
}

class Model {
  /** current contents of the working migrations dir (name -> sql). */
  dir = new Map<string, string>();
  /** expected schema_migrations (name -> checksum). */
  applied = new Map<string, string>();
  schemaMigrationsTableExists = false;
  /** flag key -> expected {enabled, rollout}; missing => row must be absent. */
  flags = new Map<string, { enabled: boolean; rollout: number }>();
  flagsEverSeeded = false;
  offerings = new Map<string, OfferingExpectation>();
  offeringsEverSeeded = false;
  /** drill slug -> expected active. */
  drills = new Map<string, boolean>();
  frozen = new Map<string, ModelSnapshot>();
  /** validating model id -> expected config state. */
  validatingTampered = new Set<string>();
  catalogSeeded = false;
  extraCounter = 0;

  constructor(readonly canonical: MigrationFile[]) {
    for (const f of canonical) this.dir.set(f.name, f.sql);
  }

  canonicalNames(): string[] {
    return this.canonical.map((f) => f.name);
  }

  hasApplied(prefix: string): boolean {
    for (const n of this.applied.keys()) if (n.startsWith(prefix)) return true;
    return false;
  }

  allCanonicalApplied(): boolean {
    return this.canonical.every((f) => this.applied.has(f.name));
  }

  /** Tables the seed needs exist once 0007 is in (0002/0005 precede it). */
  seedTablesExist(): boolean {
    return this.hasApplied("0007_");
  }

  releaseEvidenceExists(): boolean {
    return this.hasApplied("0013_");
  }

  /** What runMigrations(dir) must do given the current model. */
  predictMigrate(dirNames: string[]): {
    applied: string[];
    skipped: string[];
    error: string | null;
  } {
    const ordered = orderMigrations(dirNames);
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const name of ordered) {
      const sql = this.dir.get(name) ?? "";
      const recorded = this.applied.get(name);
      if (recorded !== undefined) {
        if (recorded !== checksumOf(sql)) return { applied, skipped, error: "checksum_mismatch" };
        skipped.push(name);
        continue;
      }
      if (sql.includes("STRESS_FAIL_HERE")) return { applied, skipped, error: `failed:${name}` };
      applied.push(name);
    }
    return { applied, skipped, error: null };
  }

  reset(): void {
    this.applied.clear();
    this.schemaMigrationsTableExists = false;
    this.flags.clear();
    this.flagsEverSeeded = false;
    this.offerings.clear();
    this.offeringsEverSeeded = false;
    this.drills.clear();
    this.frozen.clear();
    this.validatingTampered.clear();
    this.catalogSeeded = false;
  }

  /** Model transition for a successful seed(). */
  applySeed(): void {
    for (const [key, , enabled, rollout] of SEEDED_FEATURE_FLAGS) {
      if (!this.flags.has(key)) this.flags.set(key, { enabled, rollout });
    }
    this.flagsEverSeeded = true;
    for (const [key, price] of SEEDED_OFFERINGS) this.offerings.set(key, { active: true, price });
    for (const [key, exp] of this.offerings) {
      if (!SEEDED_OFFERINGS.some(([k]) => k === key))
        this.offerings.set(key, { ...exp, active: false });
    }
    this.offeringsEverSeeded = true;
    for (const slug of this.drills.keys()) this.drills.set(slug, false);
    this.validatingTampered.clear();
    this.catalogSeeded = true;
  }
}

function idx(r: number, n: number): number {
  return Math.min(n - 1, Math.floor(r * n));
}

export function classifyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/checksum mismatch/.test(msg)) return "checksum_mismatch";
  const m = /^Migration (\S+) failed/.exec(msg);
  if (m) return `failed:${m[1]}`;
  if (/does not exist/.test(msg)) return "relation_missing";
  if (/Cannot use a pool after calling end/.test(msg)) return "pool_ended";
  if (/terminat|Connection|connection|closed|ended/i.test(msg)) return "connection_lost";
  return `other:${msg.slice(0, 80)}`;
}

async function tableExists(pool: pg.Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [
    `public.${name}`,
  ]);
  return rows[0]?.ok === true;
}

async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? -1;
}

async function snapshotModel(pool: pg.Pool, id: string): Promise<ModelSnapshot | null> {
  const { rows } = await pool.query<ModelSnapshot>(
    `SELECT config::text AS config, status,
            min_analysis_confidence::text AS "minConf",
            lower_confidence_threshold::text AS "lowerConf",
            (SELECT count(*)::int FROM scoring_model_checkpoint c WHERE c.scoring_model_id = m.id) AS checkpoints,
            (SELECT count(*)::int FROM scoring_target t WHERE t.scoring_model_id = m.id) AS targets,
            (SELECT coalesce(sum(weight),0)::text FROM scoring_model_checkpoint c WHERE c.scoring_model_id = m.id) AS "weightSum"
     FROM scoring_model m WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function partialDir(model: Model, root: string, upTo: string): Promise<string> {
  const dir = await mkdtemp(join(root, "partial-"));
  for (const [name, sql] of model.dir) {
    if (name <= upTo) await writeFile(join(dir, name), sql, "utf8");
  }
  return dir;
}

async function resetSchema(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

export async function runDbSequence(
  ctx: DbContext,
  seed: number,
  actions?: DbActionSpec[],
): Promise<DbSequenceResult> {
  const started = Date.now();
  const spec = actions ?? generateDbSequence(seed).actions;
  const { pool } = ctx;
  const model = new Model(ctx.canonical);
  const failures: DbFailure[] = [];
  const observations: Record<string, number> = {};
  const trace: DbStep[] = [];
  const observe = (k: string) => {
    observations[k] = (observations[k] ?? 0) + 1;
  };
  const fail = (step: number, kind: DbActionKind, invariant: string, detail: string) => {
    failures.push({ step, kind, invariant, detail: detail.slice(0, 600) });
  };

  const root = await mkdtemp(join(tmpdir(), `pickle-stress-db-${seed}-`));
  const workDir = join(root, "migrations");
  await mkdir(workDir);
  for (const f of ctx.canonical)
    await copyFile(join(MIGRATIONS_DIR, f.name), join(workDir, f.name));

  const writeWork = async (name: string, sql: string) => {
    model.dir.set(name, sql);
    await writeFile(join(workDir, name), sql, "utf8");
  };
  const removeWork = async (name: string) => {
    model.dir.delete(name);
    await unlink(join(workDir, name));
  };

  /** Runs migrate against dir and checks M2 against the model prediction. */
  const migrateChecked = async (
    i: number,
    kind: DbActionKind,
    dir: string,
    dirNames: string[],
    outcome: Record<string, unknown>,
  ) => {
    const predicted = model.predictMigrate(dirNames);
    let result: { applied: string[]; skipped: string[] } | null = null;
    let errClass: string | null = null;
    try {
      result = await runMigrations(pool, dir);
    } catch (error) {
      errClass = classifyError(error);
    }
    model.schemaMigrationsTableExists = true;
    // Whatever the runner reports applied is what the model records.
    for (const name of predicted.applied) {
      const sql = model.dir.get(name);
      if (sql !== undefined) model.applied.set(name, checksumOf(sql));
    }
    outcome["applied"] = result?.applied ?? null;
    outcome["skipped"] = result?.skipped.length ?? null;
    outcome["error"] = errClass;
    if (predicted.error === null) {
      if (!result) {
        fail(i, kind, "M2", `unexpected error ${errClass}; predicted applied ${predicted.applied}`);
        return;
      }
      if (JSON.stringify(result.applied) !== JSON.stringify(predicted.applied))
        fail(i, kind, "M2", `applied ${result.applied} want ${predicted.applied}`);
      if (JSON.stringify(result.skipped) !== JSON.stringify(predicted.skipped))
        fail(i, kind, "M2", `skipped ${result.skipped} want ${predicted.skipped}`);
    } else {
      if (result) {
        fail(
          i,
          kind,
          predicted.error === "checksum_mismatch" ? "M3" : "M4",
          `expected ${predicted.error}, runner succeeded`,
        );
        return;
      }
      if (errClass !== predicted.error)
        fail(
          i,
          kind,
          predicted.error === "checksum_mismatch" ? "M3" : "M4",
          `error ${errClass} want ${predicted.error}`,
        );
    }
  };

  const checkInvariants = async (i: number, kind: DbActionKind) => {
    // M1: schema_migrations mirrors the model exactly.
    const smExists = await tableExists(pool, "schema_migrations");
    if (!smExists) {
      if (model.applied.size > 0)
        fail(i, kind, "M1", "schema_migrations missing but model has applied rows");
    } else {
      const { rows } = await pool.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM schema_migrations ORDER BY name",
      );
      const actual = rows.map((r) => `${r.name}:${r.checksum}`).join(",");
      const expected = [...model.applied.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([n, c]) => `${n}:${c}`)
        .join(",");
      if (actual !== expected)
        fail(i, kind, "M1", `schema_migrations=[${actual}] model=[${expected}]`);
      const distinct = await count(
        pool,
        "SELECT count(DISTINCT name)::int AS n FROM schema_migrations",
      );
      if (distinct !== rows.length) fail(i, kind, "M1", "duplicate names in schema_migrations");
    }
    // Rolled-back failing migrations leave no objects (M4).
    if (await tableExists(pool, "stress_fail_marker"))
      fail(i, kind, "M4", "stress_fail_marker table exists");
    // Extra migrations applied => their tables exist.
    for (const name of model.applied.keys()) {
      const m = /^\d{4}_stress_extra_(\d+)\.sql$/.exec(name);
      if (m && !(await tableExists(pool, `stress_extra_${m[1]}`)))
        fail(i, kind, "M2", `applied ${name} but stress_extra_${m[1]} missing`);
    }

    if (!model.seedTablesExist()) return;

    // S2: frozen models untouched.
    for (const [id, snap] of model.frozen) {
      const now = await snapshotModel(pool, id);
      if (JSON.stringify(now) !== JSON.stringify(snap))
        fail(
          i,
          kind,
          "S2",
          `frozen model ${id} changed: ${JSON.stringify(now)} vs ${JSON.stringify(snap)}`,
        );
    }

    // Flags: exact expected values for every key the model knows.
    if (model.flagsEverSeeded) {
      const { rows } = await pool.query<{ key: string; enabled: boolean; rollout_percent: number }>(
        "SELECT key, enabled, rollout_percent FROM feature_flag",
      );
      const byKey = new Map(rows.map((r) => [r.key, r]));
      for (const [key] of SEEDED_FEATURE_FLAGS) {
        const exp = model.flags.get(key);
        const row = byKey.get(key);
        if (!exp) {
          if (row) fail(i, kind, "S3", `flag ${key} should be absent`);
          continue;
        }
        if (!row) {
          fail(i, kind, "S3", `flag ${key} missing`);
          continue;
        }
        if (row.enabled !== exp.enabled || row.rollout_percent !== exp.rollout)
          fail(
            i,
            kind,
            "S3",
            `flag ${key} = ${row.enabled}/${row.rollout_percent} want ${exp.enabled}/${exp.rollout}`,
          );
      }
    }

    // Offerings.
    if (model.offeringsEverSeeded) {
      const { rows } = await pool.query<{
        product_key: string;
        active: boolean;
        price_usd_cents: number | null;
      }>("SELECT product_key, active, price_usd_cents FROM billing_offering");
      const byKey = new Map(rows.map((r) => [r.product_key, r]));
      for (const [key, exp] of model.offerings) {
        const row = byKey.get(key);
        if (!row) {
          fail(i, kind, "S3", `offering ${key} missing`);
          continue;
        }
        if (row.active !== exp.active)
          fail(i, kind, "S3", `offering ${key} active=${row.active} want ${exp.active}`);
        if (exp.price !== null && row.price_usd_cents !== exp.price)
          fail(i, kind, "S3", `offering ${key} price=${row.price_usd_cents} want ${exp.price}`);
      }
      for (const row of rows) {
        if (!model.offerings.has(row.product_key))
          fail(i, kind, "S3", `unexpected offering ${row.product_key}`);
      }
    }

    // Drills.
    for (const [slug, active] of model.drills) {
      const { rows } = await pool.query<{ active: boolean }>(
        "SELECT active FROM drill WHERE slug = $1",
        [slug],
      );
      if (rows[0]?.active !== active)
        fail(i, kind, "S3", `drill ${slug} active=${rows[0]?.active} want ${active}`);
    }

    if (!model.catalogSeeded) return;

    // S1 catalog counts.
    const shotTypes = await count(pool, "SELECT count(*)::int AS n FROM shot_type");
    if (shotTypes !== SHOT_TYPES.length) fail(i, kind, "S1", `shot_type=${shotTypes}`);
    const checkpoints = await count(pool, "SELECT count(*)::int AS n FROM checkpoint_definition");
    if (checkpoints !== CHECKPOINTS.length)
      fail(i, kind, "S1", `checkpoint_definition=${checkpoints}`);
    const models = await count(pool, "SELECT count(*)::int AS n FROM scoring_model");
    if (models !== getAllShotScoringConfigs().length)
      fail(i, kind, "S1", `scoring_model=${models}`);
    const active = await count(
      pool,
      "SELECT count(*)::int AS n FROM scoring_model WHERE status = 'active'",
    );
    const expectedActive = [...model.frozen.values()].filter((s) => s.status === "active").length;
    if (active !== expectedActive)
      fail(i, kind, "S1", `active models=${active} want ${expectedActive}`);
    const achievements = await count(pool, "SELECT count(*)::int AS n FROM achievement");
    if (achievements !== ACHIEVEMENT_COUNT) fail(i, kind, "S1", `achievement=${achievements}`);
    const activeOfferings = await pool.query<{ product_key: string }>(
      "SELECT product_key FROM billing_offering WHERE active ORDER BY product_key",
    );
    const activeKeys = activeOfferings.rows.map((r) => r.product_key).join(",");
    const expectedActiveKeys = [...model.offerings.entries()]
      .filter(([, exp]) => exp.active)
      .map(([key]) => key)
      .sort()
      .join(",");
    if (activeKeys !== expectedActiveKeys)
      fail(i, kind, "S1", `active offerings=${activeKeys} want ${expectedActiveKeys}`);

    // S3 / N1: every pre-release model carries the generated hypothesis and
    // finite numbers.
    const { rows: preRelease } = await pool.query<{
      id: string;
      slug: string;
      config: { shotConfigVersion?: string; tampered?: boolean };
      min_analysis_confidence: string;
      lower_confidence_threshold: string;
    }>(
      `SELECT m.id, s.slug, m.config, m.min_analysis_confidence::text, m.lower_confidence_threshold::text
       FROM scoring_model m JOIN shot_type s ON s.id = m.shot_type_id
       WHERE m.status IN ('draft','validating')`,
    );
    const configs = new Map<string, ReturnType<typeof getAllShotScoringConfigs>[number]>(
      getAllShotScoringConfigs().map((c) => [c.shotType, c]),
    );
    for (const row of preRelease) {
      const cfg = configs.get(row.slug);
      if (!cfg) continue;
      if (row.config.tampered === true || row.config.shotConfigVersion !== cfg.shotConfigVersion)
        fail(
          i,
          kind,
          "S3",
          `validating model ${row.slug} config not refreshed: ${JSON.stringify(row.config)}`,
        );
      if (
        Number(row.min_analysis_confidence) !== cfg.minAnalysisConfidence ||
        Number(row.lower_confidence_threshold) !== cfg.lowerConfidenceThreshold
      )
        observe("threshold_drift_after_seed");
      const cps = await pool.query<{ slug: string; weight: string }>(
        `SELECT d.slug, c.weight::text FROM scoring_model_checkpoint c
         JOIN checkpoint_definition d ON d.id = c.checkpoint_definition_id WHERE c.scoring_model_id = $1`,
        [row.id],
      );
      for (const cp of cps.rows) {
        const want = cfg.checkpoints.find((c) => c.key === cp.slug);
        if (want && Number(cp.weight) !== want.weight)
          fail(
            i,
            kind,
            "S3",
            `checkpoint ${row.slug}/${cp.slug} weight=${cp.weight} want ${want.weight}`,
          );
      }
    }
    const nonFinite = await count(
      pool,
      `SELECT count(*)::int AS n FROM scoring_target t JOIN scoring_model m ON m.id = t.scoring_model_id
       WHERE m.status IN ('draft','validating') AND (
         t.lower_bound = 'NaN'::float8 OR t.upper_bound = 'NaN'::float8 OR t.sigma = 'NaN'::float8
         OR t.lower_bound IN ('Infinity'::float8, '-Infinity'::float8)
         OR t.upper_bound IN ('Infinity'::float8, '-Infinity'::float8)
         OR t.sigma IN ('Infinity'::float8, '-Infinity'::float8)
         OR t.metric_weight = 'NaN'::numeric)`,
    );
    if (nonFinite !== 0) fail(i, kind, "N1", `${nonFinite} non-finite scoring_target rows`);
    const nonFiniteCp = await count(
      pool,
      `SELECT count(*)::int AS n FROM scoring_model_checkpoint c JOIN scoring_model m ON m.id = c.scoring_model_id
       WHERE m.status IN ('draft','validating')
         AND (c.weight = 'NaN'::numeric OR c.coach_priority = 'NaN'::numeric OR c.changeability = 'NaN'::numeric)`,
    );
    if (nonFiniteCp !== 0) fail(i, kind, "N1", `${nonFiniteCp} non-finite checkpoint rows`);
    const nonFiniteModel = await count(
      pool,
      `SELECT count(*)::int AS n FROM scoring_model
       WHERE status IN ('draft','validating')
         AND (min_analysis_confidence = 'NaN'::numeric OR lower_confidence_threshold = 'NaN'::numeric)`,
    );
    if (nonFiniteModel !== 0) fail(i, kind, "N1", `${nonFiniteModel} non-finite model thresholds`);
  };

  const seedChecked = async (i: number, kind: DbActionKind, outcome: Record<string, unknown>) => {
    const expectOk = model.seedTablesExist();
    let errClass: string | null = null;
    try {
      await runSeed(pool);
    } catch (error) {
      errClass = classifyError(error);
    }
    outcome["error"] = errClass;
    if (expectOk) {
      if (errClass !== null) {
        fail(i, kind, "S1", `seed failed on migrated schema: ${errClass}`);
        return;
      }
      model.applySeed();
    } else if (errClass === null) {
      fail(i, kind, "S1", "seed succeeded although 0007 tables are missing");
    } else if (errClass !== "relation_missing") {
      fail(i, kind, "S1", `seed on partial schema failed with ${errClass}, want relation_missing`);
    }
  };

  /** Non-frozen scoring model ids ordered by shot slug (deterministic pick). */
  const pickValidatingModel = async (r: number): Promise<{ id: string; slug: string } | null> => {
    const { rows } = await pool.query<{ id: string; slug: string }>(
      `SELECT m.id, s.slug FROM scoring_model m JOIN shot_type s ON s.id = m.shot_type_id
       WHERE m.status IN ('draft','validating') ORDER BY s.slug`,
    );
    const candidates = rows.filter((row) => !model.frozen.has(row.id));
    if (candidates.length === 0) return null;
    return candidates[idx(r, candidates.length)] ?? null;
  };

  try {
    await resetSchema(pool);
    model.reset();
    for (let i = 0; i < spec.length; i++) {
      const action = spec[i];
      if (!action) break;
      const outcome: Record<string, unknown> = {};
      const dirNames = [...model.dir.keys()];
      switch (action.kind) {
        case "migrate_full": {
          await migrateChecked(i, action.kind, workDir, dirNames, outcome);
          break;
        }
        case "migrate_partial": {
          const names = orderMigrations(model.canonicalNames());
          const upTo = names[idx(action.r[0], names.length)];
          if (!upTo) break;
          const dir = await partialDir(model, root, upTo);
          outcome["upTo"] = upTo;
          await migrateChecked(
            i,
            action.kind,
            dir,
            dirNames.filter((n) => n <= upTo),
            outcome,
          );
          await rm(dir, { recursive: true, force: true });
          break;
        }
        case "migrate_twice": {
          await migrateChecked(i, action.kind, workDir, dirNames, outcome);
          if (failures.length > 0) break;
          const second: Record<string, unknown> = {};
          await migrateChecked(i, action.kind, workDir, dirNames, second);
          outcome["second"] = second;
          if (
            Array.isArray(second["applied"]) &&
            second["applied"].length !== 0 &&
            second["error"] === null
          )
            fail(i, action.kind, "M2", `second run applied ${JSON.stringify(second["applied"])}`);
          break;
        }
        case "seed": {
          await seedChecked(i, action.kind, outcome);
          break;
        }
        case "seed_concurrent": {
          if (!model.seedTablesExist()) {
            outcome["noop"] = "tables_missing";
            break;
          }
          const poolB = new pg.Pool({ connectionString: ctx.connectionString, max: 2 });
          poolB.on("error", () => {});
          const results = await Promise.allSettled([runSeed(pool), runSeed(poolB)]);
          await poolB.end();
          const errors = results
            .filter((r) => r.status === "rejected")
            .map((r) => classifyError(r.reason));
          outcome["errors"] = errors;
          if (errors.length > 0)
            fail(i, action.kind, "S1", `concurrent seed rejected: ${errors.join(",")}`);
          else model.applySeed();
          break;
        }
        case "migrate_concurrent": {
          const predicted = model.predictMigrate(dirNames);
          if (predicted.error !== null) {
            // Concurrency with a poisoned dir is covered by the single-runner
            // actions; keep this action about the lock.
            await migrateChecked(i, action.kind, workDir, dirNames, outcome);
            break;
          }
          const poolB = new pg.Pool({ connectionString: ctx.connectionString, max: 3 });
          poolB.on("error", () => {});
          const settled = await Promise.allSettled([
            runMigrations(pool, workDir),
            runMigrations(poolB, workDir),
          ]);
          await poolB.end();
          model.schemaMigrationsTableExists = true;
          const errors = settled
            .filter((r) => r.status === "rejected")
            .map((r) => classifyError(r.reason));
          const appliedAll = settled
            .flatMap((r) => (r.status === "fulfilled" ? r.value.applied : []))
            .sort();
          for (const name of predicted.applied) {
            const sql = model.dir.get(name);
            if (sql !== undefined) model.applied.set(name, checksumOf(sql));
          }
          outcome["errors"] = errors;
          outcome["appliedUnion"] = appliedAll;
          if (errors.length > 0)
            fail(i, action.kind, "M5", `concurrent runner rejected: ${errors.join(",")}`);
          if (JSON.stringify(appliedAll) !== JSON.stringify([...predicted.applied].sort()))
            fail(i, action.kind, "M5", `union applied ${appliedAll} want ${predicted.applied}`);
          break;
        }
        case "promote_model": {
          if (!model.catalogSeeded || !model.allCanonicalApplied()) {
            outcome["noop"] = "not_ready";
            break;
          }
          const target = await pickValidatingModel(action.r[0]);
          if (!target) {
            outcome["noop"] = "no_candidate";
            break;
          }
          const tag = `${seed}-${i}`;
          const user = await pool.query<{ id: string }>(
            "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
            [`stress|releaser-${tag}`],
          );
          const bundle = await pool.query<{ id: string }>(
            "INSERT INTO model_bundle (version, status) VALUES ($1, 'active') RETURNING id",
            [`bundle-stress-${tag}`],
          );
          await pool.query(
            `UPDATE scoring_model SET status = 'active', model_bundle_id = $1,
               dataset_snapshot_id = $2, evaluation_report_sha256 = repeat('b', 64),
               coach_validation_reference = 'coach-stress', released_by = $3,
               released_at = now(), active_from = now(),
               config = jsonb_build_object('released', true, 'tag', $2::text)
             WHERE id = $4`,
            [bundle.rows[0]?.id, `ds-${tag}`, user.rows[0]?.id, target.id],
          );
          const snap = await snapshotModel(pool, target.id);
          if (snap) model.frozen.set(target.id, snap);
          model.validatingTampered.delete(target.id);
          outcome["slug"] = target.slug;
          break;
        }
        case "retire_model": {
          if (!model.catalogSeeded) {
            outcome["noop"] = "not_ready";
            break;
          }
          const target = await pickValidatingModel(action.r[0]);
          if (!target) {
            outcome["noop"] = "no_candidate";
            break;
          }
          await pool.query(
            `UPDATE scoring_model SET status = 'retired', config = '{"retired": true}'::jsonb WHERE id = $1`,
            [target.id],
          );
          const snap = await snapshotModel(pool, target.id);
          if (snap) model.frozen.set(target.id, snap);
          model.validatingTampered.delete(target.id);
          outcome["slug"] = target.slug;
          break;
        }
        case "tamper_validating_model": {
          if (!model.catalogSeeded) {
            outcome["noop"] = "not_ready";
            break;
          }
          const target = await pickValidatingModel(action.r[0]);
          if (!target) {
            outcome["noop"] = "no_candidate";
            break;
          }
          const variant = idx(action.r[1], 4);
          outcome["slug"] = target.slug;
          outcome["variant"] = variant;
          if (variant === 0) {
            await pool.query(
              `UPDATE scoring_model SET config = '{"tampered": true}'::jsonb,
                 min_analysis_confidence = 0.1234, lower_confidence_threshold = 0.4321 WHERE id = $1`,
              [target.id],
            );
          } else if (variant === 1) {
            await pool.query(
              `UPDATE scoring_model_checkpoint SET weight = 99 WHERE scoring_model_id = $1`,
              [target.id],
            );
          } else if (variant === 2) {
            await pool.query(
              `UPDATE scoring_target SET lower_bound = 'NaN'::float8, sigma = 'Infinity'::float8
               WHERE scoring_model_id = $1`,
              [target.id],
            );
          } else {
            await pool.query(
              `UPDATE scoring_target SET metric_weight = 'NaN'::numeric WHERE scoring_model_id = $1`,
              [target.id],
            );
          }
          model.validatingTampered.add(target.id);
          model.catalogSeeded = false; // catalog checks resume after the next seed
          break;
        }
        case "flip_flag": {
          if (!model.flagsEverSeeded) {
            outcome["noop"] = "not_seeded";
            break;
          }
          const entry = SEEDED_FEATURE_FLAGS[idx(action.r[0], SEEDED_FEATURE_FLAGS.length)];
          if (!entry) break;
          const key = entry[0];
          const current = model.flags.get(key);
          if (!current) {
            outcome["noop"] = "absent";
            break;
          }
          const next = { enabled: !current.enabled, rollout: idx(action.r[1], 101) };
          await pool.query(
            "UPDATE feature_flag SET enabled = $2, rollout_percent = $3 WHERE key = $1",
            [key, next.enabled, next.rollout],
          );
          model.flags.set(key, next);
          outcome["key"] = key;
          outcome["next"] = next;
          break;
        }
        case "delete_flag": {
          if (!model.flagsEverSeeded) {
            outcome["noop"] = "not_seeded";
            break;
          }
          const entry = SEEDED_FEATURE_FLAGS[idx(action.r[0], SEEDED_FEATURE_FLAGS.length)];
          if (!entry) break;
          await pool.query("DELETE FROM feature_flag WHERE key = $1", [entry[0]]);
          model.flags.delete(entry[0]);
          outcome["key"] = entry[0];
          break;
        }
        case "rogue_offering": {
          if (!model.seedTablesExist()) {
            outcome["noop"] = "tables_missing";
            break;
          }
          const key = `rogue_${seed}_${i}`;
          const price = idx(action.r[0], 10000);
          await pool.query(
            `INSERT INTO billing_offering (product_key, display_name, price_usd_cents, period, active)
             VALUES ($1, 'Rogue', $2, 'lifetime', true)`,
            [key, price],
          );
          model.offerings.set(key, { active: true, price });
          outcome["key"] = key;
          break;
        }
        case "mutate_seeded_offering": {
          if (!model.offeringsEverSeeded) {
            outcome["noop"] = "not_seeded";
            break;
          }
          const entry = SEEDED_OFFERINGS[idx(action.r[0], SEEDED_OFFERINGS.length)];
          if (!entry) break;
          const deactivate = action.r[1] < 0.5;
          const price = 1 + idx(action.r[2], 99999);
          await pool.query(
            "UPDATE billing_offering SET active = $2, price_usd_cents = $3 WHERE product_key = $1",
            [entry[0], !deactivate, price],
          );
          model.offerings.set(entry[0], { active: !deactivate, price });
          outcome["key"] = entry[0];
          outcome["active"] = !deactivate;
          break;
        }
        case "fixture_drill": {
          if (!model.seedTablesExist()) {
            outcome["noop"] = "tables_missing";
            break;
          }
          const slug = `stress_fixture_${seed}_${i}`;
          await pool.query(
            "INSERT INTO drill (slug, title, is_dev_fixture, active) VALUES ($1, 'Fixture', true, true)",
            [slug],
          );
          model.drills.set(slug, true);
          outcome["slug"] = slug;
          break;
        }
        case "tamper_applied_file": {
          const appliedCanonical = model.canonicalNames().filter((n) => model.applied.has(n));
          if (appliedCanonical.length === 0) {
            outcome["noop"] = "nothing_applied";
            break;
          }
          const name = appliedCanonical[idx(action.r[0], appliedCanonical.length)];
          if (!name) break;
          const original = model.dir.get(name) ?? "";
          await writeWork(name, `${original}\n-- tampered ${seed}-${i}\n`);
          outcome["name"] = name;
          const inner: Record<string, unknown> = {};
          await migrateChecked(i, action.kind, workDir, [...model.dir.keys()], inner);
          outcome["migrate"] = inner;
          await writeWork(name, original);
          break;
        }
        case "add_extra_migration": {
          model.extraCounter++;
          const n = model.extraCounter;
          // Sorts after every canonical file; distinct per sequence step.
          const name = `${String(21 + idx(action.r[0], 70)).padStart(4, "0")}_stress_extra_${n}.sql`;
          if (model.dir.has(name)) {
            outcome["noop"] = "name_taken";
            break;
          }
          await writeWork(name, `CREATE TABLE stress_extra_${n} (id int PRIMARY KEY);\n`);
          outcome["name"] = name;
          if (action.r[1] < 0.7) {
            const inner: Record<string, unknown> = {};
            await migrateChecked(i, action.kind, workDir, [...model.dir.keys()], inner);
            outcome["migrate"] = inner;
          }
          break;
        }
        case "add_failing_migration": {
          const name = `${String(21 + idx(action.r[0], 70)).padStart(4, "0")}_stress_fail_${i}.sql`;
          if (model.dir.has(name)) {
            outcome["noop"] = "name_taken";
            break;
          }
          // First statement succeeds, second fails: the table must be rolled back.
          await writeWork(
            name,
            `CREATE TABLE stress_fail_marker (id int);\n-- STRESS_FAIL_HERE\nSELECT 1/0;\n`,
          );
          outcome["name"] = name;
          const inner: Record<string, unknown> = {};
          await migrateChecked(i, action.kind, workDir, [...model.dir.keys()], inner);
          outcome["migrate"] = inner;
          await removeWork(name);
          break;
        }
        case "add_malformed_name": {
          const variants = [
            `0${String(21 + idx(action.r[1], 70))}_Stress_Upper_${i}.sql`,
            `${String(21 + idx(action.r[1], 70)).padStart(4, "0")}-stress-dash-${i}.sql`,
            `${String(21 + idx(action.r[1], 70)).padStart(4, "0")}_stress_ext_${i}.SQL`,
            `${String(21 + idx(action.r[1], 70))}_stress_short_${i}.sql`,
          ];
          const name = variants[idx(action.r[0], variants.length)] ?? `${21 + i}_stress_short.sql`;
          await writeWork(name, `CREATE TABLE stress_malformed_${i} (id int);\n`);
          outcome["name"] = name;
          const inner: Record<string, unknown> = {};
          await migrateChecked(i, action.kind, workDir, [...model.dir.keys()], inner);
          outcome["migrate"] = inner;
          if (await tableExists(pool, `stress_malformed_${i}`))
            fail(i, action.kind, "M2", `malformed name ${name} was applied`);
          else observe("malformed_name_silently_ignored");
          await removeWork(name);
          break;
        }
        case "kill_mid_migration":
        case "end_pool_mid_migration": {
          if (action.kind === "kill_mid_migration") {
            // A deliberately slow pending file (sorts after every canonical and
            // extra file) so the kill reliably lands while the runner is busy.
            const slowName = `0099_stress_slow_${i}.sql`;
            if (!model.dir.has(slowName))
              await writeWork(
                slowName,
                `SELECT pg_sleep(0.25);\nCREATE TABLE stress_slow_${i} (id int PRIMARY KEY);\n`,
              );
          }
          const predicted = model.predictMigrate([...model.dir.keys()]);
          if (predicted.error !== null || predicted.applied.length < 3) {
            outcome["noop"] = "not_enough_pending";
            break;
          }
          const before = model.applied.size;
          const appName = `stress-victim-${seed}-${i}`;
          const target = before + 1 + idx(action.r[0], Math.max(1, predicted.applied.length - 1));
          const pollUntil = async (isSettled: () => boolean) => {
            const deadline = Date.now() + (ctx.killDelayMs ?? 20_000);
            while (!isSettled() && Date.now() < deadline) {
              const n = (await tableExists(pool, "schema_migrations"))
                ? await count(pool, "SELECT count(*)::int AS n FROM schema_migrations")
                : 0;
              if (n >= target) return;
              await new Promise((r) => setTimeout(r, 2));
            }
          };
          const withTimeout = <T>(p: Promise<T>, onTimeout: () => T): Promise<T> =>
            Promise.race([
              p,
              new Promise<T>((resolve) => setTimeout(() => resolve(onTimeout()), 30_000)),
            ]);

          if (action.kind === "kill_mid_migration") {
            const victim = spawnVictim(ctx.connectionString, workDir, appName);
            await pollUntil(victim.exited);
            const { rows } = await pool.query<{ pid: number }>(
              "SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity WHERE application_name = $1",
              [appName],
            );
            observe(rows.length > 0 ? "kill:backends_terminated" : "kill:no_backend_found");
            const exit = await withTimeout(victim.done, () => {
              victim.kill();
              return {
                code: null,
                signal: "SIGKILL" as const,
                stdout: "",
                stderr: "stress: runner hung",
              };
            });
            if (exit.stderr.includes("stress: runner hung"))
              fail(i, action.kind, "M6", "runner did not settle within 30s");
            else if (exit.code === 0) observe("kill:fulfilled");
            else if (exit.code === 3) {
              const parsed = JSON.parse(exit.stdout.trim().split("\n").pop() ?? "{}") as {
                error?: string;
              };
              const cls = classifyError(new Error(parsed.error ?? ""));
              observe(`kill:rejected:${cls.startsWith("failed:") ? "failed:<migration>" : cls}`);
            } else {
              observe("kill:process_crashed");
              const firstLine =
                exit.stderr
                  .split("\n")
                  .find((l) => /Unhandled|Error|error:/.test(l))
                  ?.trim() ?? exit.stderr.slice(0, 200);
              fail(
                i,
                action.kind,
                "C1",
                `victim exited code=${exit.code} signal=${exit.signal} (${rows.length} backends terminated): ${firstLine}`,
              );
            }
          } else {
            const victim = new pg.Pool({
              connectionString: ctx.connectionString,
              max: 4,
              application_name: appName,
            });
            let victimPoolErrors = 0;
            victim.on("error", () => {
              victimPoolErrors++;
            });
            const settledPromise = runMigrations(victim, workDir).then(
              (v) => ({ ok: true as const, v }),
              (e: unknown) => ({ ok: false as const, e }),
            );
            await new Promise((r) => setTimeout(r, 5 + idx(action.r[1], 120)));
            await victim.end();
            const result = await withTimeout(settledPromise, () => ({
              ok: false as const,
              e: new Error("stress: runner hung"),
            }));
            observe(`${action.kind}:${result.ok ? "fulfilled" : "rejected"}`);
            if (!result.ok) {
              const cls = classifyError(result.e);
              if (cls.startsWith("other:stress: runner hung"))
                fail(i, action.kind, "M6", "runner did not settle within 30s");
              observe(`${action.kind}:${cls.startsWith("failed:") ? "failed:<migration>" : cls}`);
            }
            if (victimPoolErrors > 0) observe(`${action.kind}:pool_error_events`);
          }
          model.schemaMigrationsTableExists = true;
          // M6: whatever was recorded is consistent and re-running completes.
          const { rows: recorded } = await pool.query<{ name: string; checksum: string }>(
            "SELECT name, checksum FROM schema_migrations",
          );
          for (const row of recorded) {
            const sql = model.dir.get(row.name);
            if (sql === undefined || checksumOf(sql) !== row.checksum)
              fail(i, action.kind, "M6", `recorded ${row.name} with foreign checksum`);
          }
          if (recorded.length < before || recorded.length > before + predicted.applied.length)
            fail(
              i,
              action.kind,
              "M6",
              `recorded ${recorded.length} rows, expected within [${before}, ${before + predicted.applied.length}]`,
            );
          for (const row of recorded)
            if (!model.applied.has(row.name)) model.applied.set(row.name, row.checksum);
          const resume = await runMigrations(pool, workDir).then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e }),
          );
          if (!resume.ok) fail(i, action.kind, "M6", `resume failed: ${classifyError(resume.e)}`);
          else {
            const union = new Set([...recorded.map((r) => r.name), ...resume.v.applied]);
            const expectedUnion = new Set([...model.applied.keys(), ...predicted.applied]);
            if (JSON.stringify([...union].sort()) !== JSON.stringify([...expectedUnion].sort()))
              fail(i, action.kind, "M6", `resume union mismatch`);
            for (const name of predicted.applied) {
              const sql = model.dir.get(name);
              if (sql !== undefined) model.applied.set(name, checksumOf(sql));
            }
          }
          break;
        }
        case "reset_schema": {
          await resetSchema(pool);
          model.reset();
          break;
        }
      }
      const hardFailure = () => failures.some((f) => f.invariant !== "C1");
      if (!hardFailure()) await checkInvariants(i, action.kind);
      trace.push({ i, kind: action.kind, outcome });
      if (hardFailure()) break;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return {
    lens: "db",
    seed,
    length: spec.length,
    executedSteps: trace.length,
    status: failures.length === 0 ? "HELD" : "BROKEN",
    failures,
    observations,
    trace,
    durationMs: Date.now() - started,
  };
}

export function dbTraceKey(result: DbSequenceResult): string {
  return JSON.stringify({
    t: result.trace,
    f: result.failures.filter((f) => f.invariant !== "C1"),
  });
}
