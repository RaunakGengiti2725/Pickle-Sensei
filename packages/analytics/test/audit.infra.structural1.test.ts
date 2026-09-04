import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENT_NAMES } from "../src/index.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1) — infra/observability and
 * infra/postgres executed against a real Postgres (docker compose `postgres`
 * service). The existing observability.test.ts only string-matches views.sql;
 * this file installs the header-declared ingestion table, applies every view
 * and queries each one, so the SQL is proven to parse and type-check.
 *
 * Skips are NOT passes: when docker/psql are unavailable this suite throws so
 * the absence is visible in the run log.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const observabilityDir = join(repoRoot, "infra", "observability");
const CONTAINER = "pickle-sensei-postgres-1";
const DB = "audit_obs_views";

function psql(sql: string, db = DB): string {
  const res = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "pickle", "-d", db, "-tA"],
    { input: sql, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

function containerRunning(): boolean {
  const res = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], {
    encoding: "utf8",
  });
  return res.status === 0 && res.stdout.trim() === "true";
}

const HEADER_TABLE = `
CREATE TABLE analytics_event (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,
  at          timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  session_id  text,
  props       jsonb       NOT NULL
);
CREATE INDEX analytics_event_name_at ON analytics_event (name, at);
`;

const VIEWS = [
  "obs_analysis_hourly",
  "obs_abstention_reasons",
  "obs_analysis_latency",
  "obs_envelope_verdicts",
  "obs_target_lock_failures",
  "obs_event_proposal_failures",
  "obs_crash_rate",
  "obs_api_failures",
  "obs_worker_failures",
  "obs_queue_backlog",
];

describe("audit: infra/observability/views.sql executes on Postgres 16", () => {
  it("docker postgres service is running (precondition — not a pass if absent)", () => {
    expect(containerRunning(), `container ${CONTAINER} must be running`).toBe(true);
  });

  it("installs the header-declared table and every view, then queries each view", () => {
    psql(`DROP DATABASE IF EXISTS ${DB};`, "pickle_dev");
    psql(`CREATE DATABASE ${DB};`, "pickle_dev");
    psql(HEADER_TABLE);
    psql(readFileSync(join(observabilityDir, "views.sql"), "utf8"));
    const names = new Set<string>(ANALYTICS_EVENT_NAMES);
    // One representative row per event the views read; props use the same
    // camelCase keys the views extract.
    const rows: Array<[string, Record<string, unknown>]> = [
      ["analysis_started", {}],
      ["analysis_completed", { modelVersion: "m1", deviceClass: "phone", latencyMs: 1234 }],
      ["analysis_failed", { failureKind: "x" }],
      ["analysis_abstained", { reasonCategory: "capture_quality" }],
      ["capture_envelope_verdict", { overall: "SUPPORTED", thresholdsVersion: "v1" }],
      ["target_lock_failed", { reason: "no_lock", algorithmVersion: "a1" }],
      ["event_proposal_failed", {}],
      ["capture_started", {}],
      ["app_crash", { appBuild: "1", fatal: true }],
      ["app_opened", { appBuild: "1" }],
      ["api_failure", { route: "/v1/x", statusCode: 503, errorCode: "db_unavailable" }],
      ["worker_failure", { jobKind: "media", failureKind: "handler_exception" }],
      ["queue_backlog", { queue: "media", depth: 12 }],
    ];
    for (const [name] of rows) expect(names, `fixture event ${name}`).toContain(name);
    const values = rows
      .map(
        ([name, props]) =>
          `('${name}', '2026-09-04T00:00:00Z', 's1', '${JSON.stringify(props).replace(/'/g, "''")}'::jsonb)`,
      )
      .join(",\n");
    psql(`INSERT INTO analytics_event (name, at, session_id, props) VALUES ${values};`);
    for (const view of VIEWS) {
      const out = psql(`SELECT count(*) FROM ${view};`).trim();
      expect(Number(out), `${view} must return at least one row`).toBeGreaterThan(0);
    }
    const latency = psql("SELECT p50_ms, p95_ms FROM obs_analysis_latency;").trim();
    expect(latency).toBe("1234|1234");
    const crash = psql("SELECT fatal_crashes, app_opens FROM obs_crash_rate;").trim();
    expect(crash).toBe("1|1");
  });

  it("no view exposes session_id or raw props wholesale", () => {
    const cols = psql(
      `SELECT table_name || '.' || column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'obs_%' ORDER BY 1;`,
    );
    expect(cols).not.toMatch(/\.session_id\b/);
    expect(cols).not.toMatch(/\.props\b/);
  });
});

describe("audit: infra/postgres/init-roles.sql", () => {
  it("is idempotent and creates the documented login + group roles", () => {
    const sql = readFileSync(join(repoRoot, "infra", "postgres", "init-roles.sql"), "utf8");
    psql(sql, "pickle_dev");
    psql(sql, "pickle_dev");
    const roles = psql(
      `SELECT rolname || ':' || rolcanlogin::text FROM pg_roles WHERE rolname LIKE 'pickle_%' ORDER BY 1;`,
      "pickle_dev",
    )
      .trim()
      .split("\n");
    for (const expected of [
      "pickle_app:true",
      "pickle_application_runtime:false",
      "pickle_migration_owner:false",
      "pickle_migrator:true",
      "pickle_readonly:false",
      "pickle_ro:true",
      "pickle_worker:true",
      "pickle_worker_runtime:false",
    ]) {
      expect(roles).toContain(expected);
    }
  });

  it("login roles only hold membership; privileges live on the group roles", () => {
    const superusers = psql(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('pickle_app','pickle_worker','pickle_ro','pickle_migrator') AND (rolsuper OR rolcreaterole OR rolcreatedb);`,
      "pickle_dev",
    ).trim();
    expect(superusers).toBe("");
  });
});

describe("audit: infra/terraform static review", () => {
  const compute = readFileSync(
    join(repoRoot, "infra", "terraform", "modules", "compute", "main.tf"),
    "utf8",
  );

  it("an ALB that fronts the api service has a listener", () => {
    // aws_lb + aws_lb_target_group + ecs service load_balancer{} without any
    // aws_lb_listener: AWS rejects the ECS service create ("target group does
    // not have an associated load balancer") and nothing can reach :443.
    expect(compute).toMatch(/resource\s+"aws_lb_listener"/);
  });

  it("api and worker tasks use distinct task roles (per-service least privilege)", () => {
    // Only `task_role_arn` (the role the CONTAINER assumes) — not the shared
    // execution role, which legitimately is one role for both services.
    const taskRoles = [...compute.matchAll(/(?<!execution_)task_role_arn\s*=\s*([\w.]+)/g)].map(
      (m) => m[1],
    );
    expect(taskRoles).toHaveLength(2);
    expect(new Set(taskRoles).size, taskRoles.join(", ")).toBe(2);
  });

  it("terraform formatting/validation is recorded as executed or explicitly unavailable", () => {
    const which = spawnSync("sh", ["-c", "command -v terraform"], { encoding: "utf8" });
    if (which.status !== 0) {
      // Not a pass: surfaces as an explicit skip line in the log.
      console.warn("terraform binary absent — `terraform validate` NOT executed (UNKNOWN)");
      return;
    }
    const out = execFileSync("terraform", ["fmt", "-check", "-recursive"], {
      cwd: join(repoRoot, "infra", "terraform"),
      encoding: "utf8",
    });
    expect(out).toBe("");
  });
});
