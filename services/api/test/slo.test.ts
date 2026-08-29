import { afterAll, describe, expect, it } from "vitest";
import { ApiSloRecorder, type ApiSloSnapshot, type SloEvaluation } from "@pickle/slo";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-test",
  databaseUrl: null,
  devAuthSecret: "test-secret-0123456789",
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
};

interface SloResponse {
  snapshot: ApiSloSnapshot;
  evaluations: SloEvaluation[];
  queueDepth: number;
  queueOldestJobAgeMs: number | null;
}

const recorder = new ApiSloRecorder();
const app = buildApp(config, { sloRecorder: recorder, rateLimit: { defaultLimit: 10_000 } });
afterAll(async () => {
  await app.close();
});

describe("API SLO surface (no database)", () => {
  it("records every response and reports availability / latency / 5xx honestly", async () => {
    for (let i = 0; i < 110; i++) await app.inject({ method: "GET", url: "/v1/health" });
    // DB is absent: catalog answers a typed 503 that must count against the
    // 5xx budget rather than disappearing.
    const failing = await app.inject({ method: "GET", url: "/v1/catalog/shot-types" });
    expect(failing.statusCode).toBe(503);

    const res = await app.inject({ method: "GET", url: "/v1/health/slo" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SloResponse;
    expect(body.snapshot.requestCount).toBeGreaterThanOrEqual(111);
    expect(body.snapshot.fiveXxCount).toBeGreaterThanOrEqual(1);
    expect(body.snapshot.availability).not.toBeNull();
    expect(body.snapshot.availability!).toBeLessThan(1);
    expect(body.snapshot.latency.p95).not.toBeNull();
    expect(body.queueDepth).toBe(0);
    expect(body.queueOldestJobAgeMs).toBeNull();
  });

  it("marks DB latency and pool saturation not_evaluable without a pool — never met", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health/slo" });
    const body = res.json() as SloResponse;
    const db = body.evaluations.find((e) => e.slo === "db_latency_p95");
    const pool = body.evaluations.find((e) => e.slo === "pool_saturation");
    expect(db?.status).toBe("not_evaluable");
    expect(pool?.status).toBe("not_evaluable");
    expect(body.snapshot.pool).toBeNull();
  });

  it("counts media-route 5xx separately (upload/storage failure surface)", async () => {
    // With no DB the authenticated media route fails before storage; the
    // separate counter is exercised directly through the recorder.
    recorder.recordRequest({ route: "/v1/media/uploads", statusCode: 503, latencyMs: 12 });
    const res = await app.inject({ method: "GET", url: "/v1/health/slo" });
    const body = res.json() as SloResponse;
    expect(body.snapshot.mediaFiveXxCount).toBeGreaterThanOrEqual(1);
  });
});
