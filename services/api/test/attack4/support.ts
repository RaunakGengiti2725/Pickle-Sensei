import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import type { FastifyInstance } from "fastify";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { publishTestScoringRelease } from "../support/scoringRelease.js";

/**
 * Shared harness for the adversarial pass-3 attack suites
 * (`services-api-legacy-admin-web`, tester #4). Every suite here runs against
 * the REAL test PostgreSQL (`DATABASE_URL_TEST`) and writes a JSON evidence
 * file under `artifacts/attack4/` so each verdict carries an artifact path.
 */

export const TEST_DATABASE_URL = process.env["DATABASE_URL_TEST"];
export const ATTACK_DEV_SECRET = "attack4-dev-secret-0123456789abcdef";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..", "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "database", "migrations");
export const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "attack4");

export function writeArtifact(name: string, payload: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const path = join(ARTIFACT_DIR, name);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

/** Drop + recreate `public`, replay every migration, seed, publish a test release. */
export async function resetTestDatabase(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, MIGRATIONS_DIR);
    await seed(pool);
    await publishTestScoringRelease(pool);
  } finally {
    await pool.end();
  }
}

export function attackConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-attack4",
    databaseUrl: TEST_DATABASE_URL ?? null,
    devAuthSecret: ATTACK_DEV_SECRET,
    oidcIssuer: undefined,
    oidcAudience: undefined,
    oidcJwksUrl: undefined,
    sqsQueueUrl: undefined,
    consentExportSigningKey: undefined,
    consentExportSigningKeyId: "consent-export-k1",
    appleIapConfigured: false,
    googlePlayConfigured: false,
    adminAuthSubjects: ["attack4|admin"],
    ...overrides,
  };
}

export function minter(env = "test"): DevTokenVerifier {
  return new DevTokenVerifier(env, ATTACK_DEV_SECRET);
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const BOOTSTRAP_BODY = {
  locale: "en-US",
  timezone: "America/Los_Angeles",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

/** Creates the app_user row behind `token` (every private route needs one). */
export async function bootstrap(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    headers: bearer(token),
    payload: BOOTSTRAP_BODY,
  });
  if (res.statusCode !== 200) {
    throw new Error(`bootstrap failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { user: { id: string } }).user.id;
}

export interface ErrorEnvelope {
  error: { kind: string; code: string; message: string; requestId: string };
}

/** Deterministic PRNG (mulberry32) so "random" subjects are reproducible from a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSubject(rng: () => number, prefix = "auth0|attack4-"): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return `${prefix}${out}`;
}
