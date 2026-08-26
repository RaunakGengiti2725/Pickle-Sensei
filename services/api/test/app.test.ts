import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-test",
  databaseUrl: null,
};

const app = buildApp(config);
afterAll(async () => {
  await app.close();
});

describe("API skeleton", () => {
  it("GET /v1/health returns ok + version", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", version: "0.1.0-test" });
  });

  it("GET /v1/openapi.json serves the generated contract", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { openapi: string; info: { title: string } };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toMatch(/Pickle Sensei/);
  });

  it("catalog fails loudly with a typed envelope when the DB is unavailable", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/catalog/shot-types" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { kind: string; code: string; requestId: string } };
    expect(body.error.kind).toBe("retryable");
    expect(body.error.code).toBe("catalog.db_unavailable");
    expect(body.error.requestId).toBeTruthy();
  });

  it("specified-but-pending routes return typed 501 — never fake success", async () => {
    for (const [method, url] of [
      ["POST", "/v1/shots:sync"],
      ["POST", "/v1/sessions"],
      ["GET", "/v1/me"],
    ] as const) {
      const res =
        method === "POST"
          ? await app.inject({ method, url, payload: {} })
          : await app.inject({ method, url });
      expect(res.statusCode).toBe(501);
      expect((res.json() as { error: { kind: string } }).error.kind).toBe("not_implemented");
    }
  });

  it("echoes/propagates x-request-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "req-abc-123" },
    });
    expect(res.headers["x-request-id"]).toBe("req-abc-123");
  });
});
