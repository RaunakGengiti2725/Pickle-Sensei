import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { SignJWT } from "jose";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { publishTestScoringRelease } from "../support/scoringRelease.js";

/**
 * Seeded concurrency stress harness for the legacy Fastify API.
 *
 * Every iteration derives a scenario and all of its randomness (actor count,
 * duplicate ratios, per-request jitter, operation order) from one 32-bit seed,
 * so any row of the results table can be replayed exactly with
 * `STRESS_SEEDS=<seed>`. Requests are fired with `Promise.all` through
 * `app.inject`; the jitter is the seeded scheduler that varies the
 * interleaving at the database.
 *
 * Nothing here touches production code: the harness only adds test-side
 * instrumentation (an `onError` hook that records Postgres SQLSTATEs behind
 * generic 500 bodies) and reads invariants straight from the test database.
 */

export const DEV_SECRET = "stress-secret-0123456789abcdef";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + seed derivation
// ---------------------------------------------------------------------------

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  uuid(): string {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = this.int(0, 255);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

/** splitmix-style derivation of the i-th iteration seed from the master seed. */
export function iterationSeed(masterSeed: number, index: number): number {
  let z = (masterSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// World: app + db + token minting + request instrumentation
// ---------------------------------------------------------------------------

export interface PgErrorRecord {
  requestId: string;
  route: string;
  method: string;
  pgCode: string | null;
  constraint: string | null;
  message: string;
}

export interface World {
  app: FastifyInstance;
  pool: pg.Pool;
  minter: DevTokenVerifier;
  adminSubject: string;
  /** Postgres SQLSTATEs observed behind 500s, keyed by request id. */
  pgErrors: Map<string, PgErrorRecord>;
  close(): Promise<void>;
}

export async function createWorld(testUrl: string): Promise<World> {
  const setupPool = new pg.Pool({ connectionString: testUrl });
  await setupPool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await runMigrations(setupPool, migrationsDir);
  await seed(setupPool);
  await publishTestScoringRelease(setupPool);
  await setupPool.end();

  const adminSubject = "auth0|stress-admin";
  const config: ApiConfig = {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-stress",
    databaseUrl: testUrl,
    devAuthSecret: DEV_SECRET,
    oidcIssuer: undefined,
    oidcAudience: undefined,
    oidcJwksUrl: undefined,
    sqsQueueUrl: undefined,
    consentExportSigningKey: undefined,
    consentExportSigningKeyId: "consent-export-k1",
    appleIapConfigured: false,
    googlePlayConfigured: false,
    adminAuthSubjects: [adminSubject],
  };
  const app = buildApp(config, { queue: new InMemoryJobQueue() });
  const pgErrors = new Map<string, PgErrorRecord>();
  app.addHook("onError", async (request, _reply, error) => {
    const pgCode = (error as { code?: unknown }).code;
    const constraint = (error as { constraint?: unknown }).constraint;
    pgErrors.set(String(request.id), {
      requestId: String(request.id),
      route: request.routeOptions.url ?? "unmatched",
      method: request.method,
      pgCode: typeof pgCode === "string" ? pgCode : null,
      constraint: typeof constraint === "string" ? constraint : null,
      message: error.message,
    });
  });
  await app.ready();
  const pool = new pg.Pool({ connectionString: testUrl, max: 4 });
  const minter = new DevTokenVerifier("test", DEV_SECRET);
  await warmConnectionPool(app, minter);
  return {
    app,
    pool,
    minter,
    adminSubject,
    pgErrors,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/**
 * A cold `pg.Pool` opens connections lazily, so the first burst of a fresh
 * process serializes on connection establishment and hides races that a warm
 * server reproduces readily. Fill the app's pool (default max 10) before any
 * scenario so a single replayed seed sees the same interleaving pressure as
 * an iteration deep inside a campaign.
 */
async function warmConnectionPool(app: FastifyInstance, minter: DevTokenVerifier): Promise<void> {
  const token = await minter.mint("auth0|stress-warmup");
  const bootstrap = await app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    headers: auth(token),
    payload: bootstrapBody,
  });
  if (bootstrap.statusCode !== 200) {
    throw new Error(`warmup bootstrap failed: ${bootstrap.statusCode} ${bootstrap.body}`);
  }
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({ method: "GET", url: "/v1/me/access", headers: auth(token) }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export interface Op {
  label: string;
  run(): Promise<LightMyRequestResponse>;
}

export interface OpResult {
  label: string;
  status: number;
  code: string | null;
  requestId: string | null;
  body: unknown;
  ms: number;
  pg: PgErrorRecord | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fires every op concurrently. The seeded scheduler shuffles the launch order
 * and prefixes each op with 0–`maxJitterMs` ms of jitter so the same seed
 * always produces the same launch pattern.
 */
export async function burst(
  rng: Rng,
  world: World,
  ops: Op[],
  maxJitterMs = 6,
): Promise<OpResult[]> {
  const scheduled = rng.shuffle(
    ops.map((op, index) => ({ op, index, jitter: rng.int(0, maxJitterMs) })),
  );
  const results = new Array<OpResult>(ops.length);
  await Promise.all(
    scheduled.map(async ({ op, index, jitter }) => {
      if (jitter > 0) await sleep(jitter);
      const started = performance.now();
      const response = await op.run();
      const ms = Math.round(performance.now() - started);
      let body: unknown = null;
      try {
        body = response.json();
      } catch {
        body = response.body;
      }
      const requestId = response.headers["x-request-id"];
      const rid = typeof requestId === "string" ? requestId : null;
      const code =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: { code?: string } }).error?.code ?? "")
          : null;
      results[index] = {
        label: op.label,
        status: response.statusCode,
        code,
        requestId: rid,
        body,
        ms,
        pg: rid ? (world.pgErrors.get(rid) ?? null) : null,
      };
    }),
  );
  return results;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export const bootstrapBody = {
  locale: "en-US",
  timezone: "America/Los_Angeles",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

export interface Actor {
  subject: string;
  token: string;
  userId: string;
}

export async function bootstrapActor(world: World, rng: Rng, role: "user" | "admin" = "user") {
  const subject = `auth0|stress-${rng.uuid()}`;
  const token = await world.minter.mint(subject, role);
  const response = await world.app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    headers: auth(token),
    payload: bootstrapBody,
  });
  if (response.statusCode !== 200) {
    throw new Error(`bootstrap failed: ${response.statusCode} ${response.body}`);
  }
  const userId = (response.json() as { user: { id: string } }).user.id;
  return { subject, token, userId } satisfies Actor;
}

export async function reservePermit(world: World, actor: Actor, idempotencyKey: string) {
  const response = await world.app.inject({
    method: "POST",
    url: "/v1/analysis-permits",
    headers: auth(actor.token),
    payload: { idempotencyKey },
  });
  if (response.statusCode !== 200) {
    throw new Error(`reserve failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { permit: { id: string } }).permit.id;
}

export function versionVector(
  scoringModelVersion = "sm-v1",
  shotConfigVersion = "forehand_drive@1",
) {
  return {
    appVersion: "0.1.0",
    modelBundleVersion: "test-native-1",
    poseModelVersion: "test-pose-1",
    paddleModelVersion: "test-paddle-1",
    strokeDetectorVersion: "test-stroke-1",
    phaseModelVersion: "test-phase-1",
    scoringModelVersion,
    shotConfigVersion,
  };
}

export function shotPayload(
  rng: Rng,
  permitId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const scored = overrides["resultKind"] !== "low_confidence";
  return {
    id: rng.uuid(),
    analysisPermitId: permitId,
    sessionId: null,
    shotType: "forehand_drive",
    cameraView: "side",
    capturedAt: new Date(Date.UTC(2026, 0, 1) + rng.int(0, 86_400_000 * 30)).toISOString(),
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    overallScore: scored ? Math.round(rng.int(30, 95)) / 10 : null,
    confidence: 0.91,
    resultKind: scored ? "scored" : "low_confidence",
    source: "real",
    phases: [
      { key: "contact", startMs: 1000, representativeMs: 1040, endMs: 1090, confidence: 0.9 },
    ],
    checkpoints: [
      {
        key: "contact_position",
        score: 58,
        confidence: 0.94,
        band: "red",
        direction: "late",
        severity: 0.42,
        applicable: true,
      },
    ],
    versionVector: versionVector(),
    ...overrides,
  };
}

/** Mints a dev token whose validity window is shifted to simulate clock skew. */
export async function mintSkewedToken(
  subject: string,
  skew: { notBeforeOffsetSec?: number; expiresOffsetSec?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ pickle_role: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("pickle-dev")
    .setSubject(subject)
    .setIssuedAt(now);
  if (skew.notBeforeOffsetSec !== undefined) jwt = jwt.setNotBefore(now + skew.notBeforeOffsetSec);
  jwt = jwt.setExpirationTime(now + (skew.expiresOffsetSec ?? 900));
  return jwt.sign(new TextEncoder().encode(DEV_SECRET));
}

// ---------------------------------------------------------------------------
// Invariant bookkeeping
// ---------------------------------------------------------------------------

export class Violations {
  readonly items: string[] = [];

  check(condition: boolean, message: string): void {
    if (!condition) this.items.push(message);
  }

  /** Any 5xx is a defect for these scenarios; the SQLSTATE is the evidence. */
  noServerErrors(results: OpResult[]): void {
    for (const r of results) {
      if (r.status >= 500) {
        const pg = r.pg
          ? ` pg=${r.pg.pgCode ?? "?"}${r.pg.constraint ? `(${r.pg.constraint})` : ""}`
          : "";
        this.items.push(`${r.label}: HTTP ${r.status} ${r.code ?? ""}${pg}`);
      }
    }
  }

  statusIn(results: OpResult[], allowed: number[]): void {
    for (const r of results) {
      if (!allowed.includes(r.status)) {
        const pg = r.pg
          ? ` pg=${r.pg.pgCode ?? "?"}${r.pg.constraint ? `(${r.pg.constraint})` : ""}`
          : "";
        this.items.push(
          `${r.label}: HTTP ${r.status} ${r.code ?? ""} not in {${allowed.join(",")}}${pg}`,
        );
      }
    }
  }
}

export async function count(pool: pg.Pool, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (${sql}) q`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function accessLedger(pool: pg.Pool, userId: string) {
  const account = await pool.query<{ free_successful_ratings: number }>(
    "SELECT free_successful_ratings FROM analysis_access_account WHERE user_id = $1",
    [userId],
  );
  const permits = await pool.query<{
    id: string;
    access_source: string;
    status: string;
    outcome: string | null;
    rating_id: string | null;
  }>(
    "SELECT id, access_source, status, outcome, rating_id FROM analysis_permit WHERE user_id = $1 ORDER BY reserved_at",
    [userId],
  );
  const shots = await pool.query<{
    id: string;
    analysis_permit_id: string | null;
    result_kind: string;
  }>("SELECT id, analysis_permit_id, result_kind FROM shot WHERE user_id = $1", [userId]);
  return {
    used: account.rows[0]?.free_successful_ratings ?? 0,
    permits: permits.rows,
    shots: shots.rows,
  };
}

/**
 * Ledger invariants that must hold for every user after every scenario:
 * - free_successful_ratings == consumed free permits == scored shots on free permits
 * - at most 2 free permits are ever consumed or live-reserved
 * - one shot per permit, one permit per scored shot
 */
export async function assertLedgerInvariants(pool: pg.Pool, userId: string, v: Violations) {
  const ledger = await accessLedger(pool, userId);
  const consumedFree = ledger.permits.filter(
    (p) => p.access_source === "free" && p.status === "consumed",
  ).length;
  const reservedFree = ledger.permits.filter(
    (p) => p.access_source === "free" && p.status === "reserved",
  ).length;
  const scoredShots = ledger.shots.filter((s) => s.result_kind === "scored");
  const permitIds = ledger.shots.map((s) => s.analysis_permit_id);
  v.check(
    ledger.used === consumedFree,
    `ledger: free_successful_ratings=${ledger.used} but consumed free permits=${consumedFree}`,
  );
  v.check(
    ledger.used <= 2,
    `ledger: free_successful_ratings=${ledger.used} exceeds lifetime limit 2`,
  );
  v.check(
    consumedFree + reservedFree <= 2,
    `ledger: consumed(${consumedFree}) + reserved(${reservedFree}) free permits exceed 2`,
  );
  v.check(
    new Set(permitIds).size === permitIds.length,
    `ledger: a permit is bound to more than one shot (${permitIds.join(",")})`,
  );
  for (const shot of scoredShots) {
    const permit = ledger.permits.find((p) => p.id === shot.analysis_permit_id);
    v.check(
      permit?.status === "consumed" && permit.outcome === "scored" && permit.rating_id === shot.id,
      `ledger: scored shot ${shot.id} has permit ${JSON.stringify(permit ?? null)} instead of consumed/scored`,
    );
  }
  for (const permit of ledger.permits) {
    if (permit.status === "consumed") {
      v.check(
        ledger.shots.some((s) => s.analysis_permit_id === permit.id && s.result_kind === "scored"),
        `ledger: consumed permit ${permit.id} has no scored shot row`,
      );
    }
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

export type Outcome = "HELD" | "BROKEN" | "TIMEOUT" | "HARNESS_ERROR";

export interface IterationRow {
  index: number;
  seed: number;
  scenario: string;
  outcome: Outcome;
  durationMs: number;
  requests: number;
  violations: string[];
  statuses: Record<string, number>;
  detail?: Record<string, unknown> | undefined;
}

export interface ResultsTable {
  unit: string;
  lens: string;
  masterSeed: number | null;
  seedsRequested: number[] | null;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  timeouts: number;
  harnessErrors: number;
  wallMs: number;
  iterationTimeoutMs: number;
  byScenario: Record<string, { executed: number; held: number; broken: number; timeouts: number }>;
  rows: IterationRow[];
}

export function writeResults(outDir: string, table: ResultsTable): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "results.json");
  writeFileSync(path, JSON.stringify(table, null, 2));
  return path;
}

export function tally(results: OpResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    const key = `${r.status}${r.code ? ` ${r.code}` : ""}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export { randomUUID };
