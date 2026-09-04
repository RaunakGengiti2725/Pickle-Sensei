import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import {
  TEST_DATABASE_URL,
  attackConfig,
  bearer,
  bootstrap,
  minter,
  resetTestDatabase,
  writeArtifact,
  type ErrorEnvelope,
} from "./support.js";

/**
 * ATTACK S4 — kill switch pulled AND Postgres gone.
 *
 * "Stopping Postgres" is done without touching the shared container: the app
 * talks to Postgres through a local TCP proxy (this test owns it). Killing
 * the proxy — listener closed, every in-flight socket destroyed — is what the
 * API sees when the database vanishes (ECONNRESET on live connections,
 * ECONNREFUSED on new ones).
 *
 * Asserts, with FLAG_KILL_SCORING_ENGINE=on:
 *   - DB up:   GET /v1/flags lists scoring_engine as disabled (kill wins).
 *   - DB down: GET /v1/flags → 503 api.datastore_unavailable, NO `flags` key
 *              (never a partial/safe-default list), and the kill-switch-gated
 *              server routes still refuse.
 *   - DB back: the same app recovers without a restart.
 */

interface FlagsBody {
  flags?: Record<string, boolean>;
  flagState?: { killSwitchesActive: string[] };
}

class PgProxy {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  constructor(
    private readonly upstreamHost: string,
    private readonly upstreamPort: number,
    readonly port: number,
  ) {}

  async start(): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.upstreamPort, this.upstreamHost);
      this.sockets.add(client);
      this.sockets.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on("error", drop);
      upstream.on("error", drop);
      client.on("close", drop);
      upstream.on("close", drop);
    });
    await new Promise<void>((resolve) => {
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.server = server;
  }

  /** The "Postgres stopped" moment: refuse new connections, cut live ones. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(!TEST_DATABASE_URL)(
  "ATTACK S4: FLAG_KILL_SCORING_ENGINE=on with Postgres down",
  () => {
    let app: FastifyInstance;
    let proxy: PgProxy;
    let userToken: string;
    const previousKill = process.env["FLAG_KILL_SCORING_ENGINE"];
    const previousSession = process.env["FLAG_KILL_SESSION_PROCESSING"];
    const previousRanker = process.env["FLAG_KILL_DRILL_RANKER"];
    const log: Array<{ phase: string; route: string; status: number; body: unknown }> = [];

    async function call(phase: string, method: "GET" | "POST", url: string, payload?: unknown) {
      const res = await app.inject({
        method,
        url,
        headers: bearer(userToken),
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      log.push({ phase, route: `${method} ${url}`, status: res.statusCode, body: res.json() });
      return res;
    }

    beforeAll(async () => {
      await resetTestDatabase(TEST_DATABASE_URL!);
      const upstream = new URL(TEST_DATABASE_URL!);
      const port = await freePort();
      proxy = new PgProxy(upstream.hostname, Number(upstream.port || 5432), port);
      await proxy.start();
      const proxied = new URL(TEST_DATABASE_URL!);
      proxied.hostname = "127.0.0.1";
      proxied.port = String(port);

      process.env["FLAG_KILL_SCORING_ENGINE"] = "on";
      process.env["FLAG_KILL_SESSION_PROCESSING"] = "on";
      process.env["FLAG_KILL_DRILL_RANKER"] = "on";
      app = buildApp(attackConfig({ databaseUrl: proxied.toString() }));
      userToken = await minter().mint("attack4|flags-user");
      await bootstrap(app, userToken);
    }, 120_000);

    afterAll(async () => {
      writeArtifact("s4-flags-datastore-down.json", { scenario: "S4", log });
      await app?.close();
      await proxy?.stop();
      for (const [name, value] of [
        ["FLAG_KILL_SCORING_ENGINE", previousKill],
        ["FLAG_KILL_SESSION_PROCESSING", previousSession],
        ["FLAG_KILL_DRILL_RANKER", previousRanker],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it("DB up: /v1/flags lists scoring_engine as killed (enabled=false) alongside the rest", async () => {
      const res = await call("db up", "GET", "/v1/flags");
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as FlagsBody;
      expect(body.flags?.["scoring_engine"]).toBe(false);
      expect(body.flagState?.killSwitchesActive).toContain("scoring_engine");
      expect(Object.keys(body.flags ?? {}).length).toBeGreaterThan(1);
    });

    it("DB up: kill-switch-gated server routes refuse with 503 api.feature_disabled", async () => {
      const finalize = await call("db up", "POST", `/v1/sessions/${randomUUID()}/finalize`);
      expect(finalize.statusCode, finalize.body).toBe(503);
      expect((finalize.json() as ErrorEnvelope).error.code).toBe("api.feature_disabled");
      const plan = await call("db up", "POST", "/v1/training-plans", {});
      expect(plan.statusCode, plan.body).toBe(503);
      expect((plan.json() as ErrorEnvelope).error.code).toBe("api.feature_disabled");
    });

    it("DB down: /v1/flags is 503 api.datastore_unavailable with no partial flag list", async () => {
      await proxy.stop();
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await call(`db down #${attempt}`, "GET", "/v1/flags");
        expect(res.statusCode, res.body).toBe(503);
        const body = res.json() as ErrorEnvelope & FlagsBody;
        expect(body.error.code).toBe("api.datastore_unavailable");
        expect(body.error.kind).toBe("retryable");
        expect(body.flags, "no partial/safe-default list may leak into a 503").toBeUndefined();
        expect(JSON.stringify(body)).not.toMatch(/scoring_engine/);
      }
    });

    it("DB down: the kill-switched routes still refuse (never 2xx)", async () => {
      const finalize = await call("db down", "POST", `/v1/sessions/${randomUUID()}/finalize`);
      expect(finalize.statusCode, finalize.body).toBe(503);
      expect(["api.feature_disabled", "api.datastore_unavailable"]).toContain(
        (finalize.json() as ErrorEnvelope).error.code,
      );
      const plan = await call("db down", "POST", "/v1/training-plans", {});
      expect(plan.statusCode, plan.body).toBe(503);
      expect(["api.feature_disabled", "api.datastore_unavailable"]).toContain(
        (plan.json() as ErrorEnvelope).error.code,
      );
      // Health stays honest about the process while the datastore is gone.
      const health = await app.inject({ method: "GET", url: "/v1/health" });
      log.push({
        phase: "db down",
        route: "GET /v1/health",
        status: health.statusCode,
        body: health.json(),
      });
      expect(health.statusCode).toBe(200);
    });

    it("DB back: the same app instance recovers and serves the killed flag list again", async () => {
      await proxy.start();
      const res = await call("db back", "GET", "/v1/flags");
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as FlagsBody;
      expect(body.flags?.["scoring_engine"]).toBe(false);
      expect(body.flagState?.killSwitchesActive).toContain("scoring_engine");
    });
  },
);
