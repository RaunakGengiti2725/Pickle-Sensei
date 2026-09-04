import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";

/**
 * h27 red team: network failure injection.
 *
 * A datastore outage must surface as a retryable 503 so the app keeps queued
 * work instead of discarding it as permanently rejected.
 */
const secret = "h27-outage-secret-0123456789";
const testUrl = process.env["DATABASE_URL_TEST"];
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

function testConfig(databaseUrl: string): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-test",
    databaseUrl,
    devAuthSecret: secret,
    oidcIssuer: undefined,
    oidcAudience: undefined,
    oidcJwksUrl: undefined,
    sqsQueueUrl: undefined,
    consentExportSigningKey: undefined,
    consentExportSigningKeyId: "k1",
    appleIapConfigured: false,
    googlePlayConfigured: false,
  };
}

describe("h27 datastore outage", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    // Nothing listens on this port: connection refused, as in an outage.
    const config = testConfig("postgres://pickle:pickle@127.0.0.1:5999/pickle_test");
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    token = await new DevTokenVerifier("test", secret).mint(`h27-outage|${randomUUID()}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("health stays honest without the database", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("authenticated reads report a retryable outage, not a permanent failure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/progress",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      error: { kind: string; code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("api.datastore_unavailable");
    expect(body.error.kind).toBe("retryable");
    expect(body.error.retryable).toBe(true);
  });

  it("sync writes report a retryable outage so the outbox is preserved", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        locale: "en-US",
        timezone: "UTC",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { retryable: boolean } }).error.retryable).toBe(true);
  });
});

/**
 * ADJ-04: PostgreSQL terminating an IDLE pooled backend (admin
 * `pg_terminate_backend`, failover, `idle_session_timeout`, restart) surfaces
 * as a pg.Pool 'error' event, not as a query rejection. Without a listener
 * Node treats it as an uncaught exception and the whole API process dies.
 * The pool must log the error through the Fastify logger, drop the dead
 * client, and keep serving.
 */
describe.skipIf(!testUrl)("h27 idle pooled connection terminated by PostgreSQL", () => {
  const ADMIN_TERMINATE_MESSAGE = "terminating connection due to administrator command";

  async function terminateBackend(pid: number): Promise<void> {
    const attacker = new pg.Client({ connectionString: testUrl });
    await attacker.connect();
    try {
      const res = await attacker.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [
        pid,
      ]);
      expect(res.rows[0]?.ok).toBe(true);
    } finally {
      await attacker.end();
    }
  }

  it("logs the pool error through the Fastify logger, discards the client, and keeps serving", async () => {
    const logLines: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    const app = buildApp(testConfig(testUrl as string), {
      queue: new InMemoryJobQueue(),
      logger: { level: "info", stream: capture },
    });
    try {
      const pool = app.appContext.pool;
      expect(pool).not.toBeNull();
      if (!pool) return;

      const warm = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = warm.rows[0]?.pid;
      expect(pid).toBeTypeOf("number");
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);

      await terminateBackend(pid as number);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const poolErrorLine = logLines.find((line) => line.includes(ADMIN_TERMINATE_MESSAGE));
      expect(poolErrorLine).toBeDefined();
      expect(JSON.parse(poolErrorLine as string)).toMatchObject({
        level: 50,
        msg: "postgres pool: idle client error",
        err: { message: ADMIN_TERMINATE_MESSAGE, code: "57P01" },
      });
      expect(pool.totalCount).toBe(0);

      const health = await app.inject({ method: "GET", url: "/v1/health" });
      expect(health.statusCode).toBe(200);

      const requery = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(requery.rows[0]?.pid).not.toBe(pid);
    } finally {
      await app.close();
    }
  });

  it("the API process survives as a real process (test/adjudicate/poolIdleTerminate.child.ts)", async () => {
    let exitCode: number | string | null = 0;
    let stdout = "";
    try {
      const child = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "test/adjudicate/poolIdleTerminate.child.ts"],
        { cwd: apiDir, env: { ...process.env, DATABASE_URL_TEST: testUrl }, timeout: 30_000 },
      );
      stdout = child.stdout;
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string };
      exitCode = failure.code ?? failure.message;
      stdout = failure.stdout ?? "";
    }
    expect(stdout, stdout).toContain("warm:");
    expect(stdout, stdout).toContain("pg_terminate_backend:true");
    expect(stdout, stdout).not.toContain("survived:false");
    expect(stdout, stdout).toMatch(/health:200 logged:true/);
    expect(stdout, stdout).toContain("survived:true");
    expect(exitCode, stdout).toBe(0);
  });
});
