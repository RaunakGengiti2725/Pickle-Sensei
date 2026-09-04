import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import {
  TEST_DATABASE_URL,
  attackConfig,
  bearer,
  bootstrap,
  minter,
  randomSubject,
  resetTestDatabase,
  seededRandom,
  writeArtifact,
  type ErrorEnvelope,
} from "./support.js";

/**
 * ATTACK S8 — pin the DEVELOPMENT admin-allowlist exception both ways
 * (authPlugin.ts `requireAdmin`):
 *   - PICKLE_ENV=development, adminAuthSubjects=[]            → any valid
 *     `pickle_role: admin` dev token reaches GET /v1/admin/quality-dashboard (200)
 *   - PICKLE_ENV=development, adminAuthSubjects=["someone-else"] → the SAME
 *     token is refused with 403 auth.admin_not_authorized
 * Extra probes: the exception must NOT leak into test/staging/production
 * (empty allowlist there means nobody is admin), and a non-admin dev token is
 * refused in development even with an empty allowlist.
 */

const SEED = 0x41544b34; // "ATK4"

describe.skipIf(!TEST_DATABASE_URL)("ATTACK S8: development admin allowlist exception", () => {
  const rng = seededRandom(SEED);
  const subject = randomSubject(rng);
  const apps: FastifyInstance[] = [];
  let adminToken: string;
  let plainToken: string;
  const results: Array<{ case: string; status: number; code?: string }> = [];

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    adminToken = await minter("development").mint(subject, "admin");
    plainToken = await minter("development").mint(subject);
    const seedApp = buildApp(attackConfig({ env: "development", adminAuthSubjects: [] }));
    apps.push(seedApp);
    await bootstrap(seedApp, adminToken);
  }, 120_000);

  afterAll(async () => {
    writeArtifact("s8-dev-admin-allowlist.json", { scenario: "S8", seed: SEED, subject, results });
    await Promise.all(apps.map((a) => a.close()));
  });

  async function dashboard(app: FastifyInstance, token: string, label: string) {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/quality-dashboard",
      headers: bearer(token),
    });
    const body = res.json() as Partial<ErrorEnvelope>;
    results.push({
      case: label,
      status: res.statusCode,
      ...(body.error ? { code: body.error.code } : {}),
    });
    return res;
  }

  it("development + adminAuthSubjects=[] admits a random admin-role subject (200)", async () => {
    const app = buildApp(attackConfig({ env: "development", adminAuthSubjects: [] }));
    apps.push(app);
    const res = await dashboard(app, adminToken, "development, allowlist=[], admin token");
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { schemaVersion: string }).schemaVersion).toBe("quality-dashboard-v1");
  });

  it("development + adminAuthSubjects=['someone-else'] refuses the same token (403 auth.admin_not_authorized)", async () => {
    const app = buildApp(attackConfig({ env: "development", adminAuthSubjects: ["someone-else"] }));
    apps.push(app);
    const res = await dashboard(
      app,
      adminToken,
      "development, allowlist=[someone-else], admin token",
    );
    expect(res.statusCode, res.body).toBe(403);
    const body = res.json() as ErrorEnvelope;
    expect(body.error.code).toBe("auth.admin_not_authorized");
    expect(body.error.kind).toBe("permission_denied");
  });

  it("development + adminAuthSubjects undefined behaves like [] (200)", async () => {
    const config = attackConfig({ env: "development" });
    delete config.adminAuthSubjects;
    const app = buildApp(config);
    apps.push(app);
    const res = await dashboard(app, adminToken, "development, allowlist=undefined, admin token");
    expect(res.statusCode, res.body).toBe(200);
  });

  it("development + adminAuthSubjects=[] still refuses a token WITHOUT the admin role", async () => {
    const app = buildApp(attackConfig({ env: "development", adminAuthSubjects: [] }));
    apps.push(app);
    const res = await dashboard(app, plainToken, "development, allowlist=[], non-admin token");
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as ErrorEnvelope).error.code).toBe("auth.admin_required");
  });

  it("the empty-allowlist exception does not exist outside development", async () => {
    // Dev tokens are only mintable in development/test; test env exercises the
    // `allowlistRequired` branch with an empty allowlist.
    const testToken = await minter("test").mint(subject, "admin");
    const app = buildApp(attackConfig({ env: "test", adminAuthSubjects: [] }));
    apps.push(app);
    const res = await dashboard(app, testToken, "test, allowlist=[], admin token");
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as ErrorEnvelope).error.code).toBe("auth.admin_not_authorized");
  });

  it("allowlist matching is exact — case/whitespace variants of the subject are refused", async () => {
    for (const variant of [
      subject.toUpperCase(),
      ` ${subject}`,
      `${subject} `,
      `${subject}\u0000`,
    ]) {
      const app = buildApp(attackConfig({ env: "development", adminAuthSubjects: [variant] }));
      apps.push(app);
      const res = await dashboard(
        app,
        adminToken,
        `development, allowlist=[${JSON.stringify(variant)}]`,
      );
      expect(res.statusCode, `${JSON.stringify(variant)} → ${res.body}`).toBe(403);
      expect((res.json() as ErrorEnvelope).error.code).toBe("auth.admin_not_authorized");
    }
  });
});
