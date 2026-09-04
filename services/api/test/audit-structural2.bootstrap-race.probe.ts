/**
 * Minimal reproducer (auditor #2): concurrent first bootstraps for one subject over a
 * REAL TCP listener (not fastify.inject), so requests genuinely overlap in the DB.
 *
 *   DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
 *     pnpm --filter @pickle/api exec tsx test/audit-structural2.bootstrap-race.probe.ts
 *
 * Exit 0 = no 5xx observed; exit 1 = at least one 5xx (finding).
 * Requires a migrated + seeded test database (any audit-structural2 integration run leaves one).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";

const testUrl = process.env["DATABASE_URL_TEST"];
if (!testUrl) {
  console.error("DATABASE_URL_TEST is required");
  process.exit(2);
}
const DEV_SECRET = "audit-structural2-secret-0123456789";
const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-audit",
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
  adminAuthSubjects: [],
};

const app = buildApp(config, { queue: new InMemoryJobQueue() });
const address = await app.listen({ port: 0, host: "127.0.0.1" });
const minter = new DevTokenVerifier("test", DEV_SECRET);
const pool = new pg.Pool({ connectionString: testUrl });

let exitCode = 0;
try {
  for (let round = 0; round < 5; round += 1) {
    const subject = `auth0|audit-race-probe-${randomUUID()}`;
    const token = await minter.mint(subject);
    const concurrency = 8;
    const responses = await Promise.all(
      Array.from({ length: concurrency }, () =>
        fetch(`${address}/v1/account/bootstrap`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            locale: "en-US",
            timezone: "America/Los_Angeles",
            device: {
              platform: "ios",
              osVersion: "18.0",
              appVersion: "0.1.0",
              model: "iPhone16,1",
            },
          }),
        }).then(async (r) => ({ status: r.status, body: await r.text() })),
      ),
    );
    const statuses = responses.map((r) => r.status);
    const rows = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app_user WHERE auth_subject = $1",
      [subject],
    );
    const fiveHundreds = responses.filter((r) => r.status >= 500);
    console.log(
      JSON.stringify({
        round,
        statuses,
        appUserRows: Number(rows.rows[0]!.n),
        firstServerError: fiveHundreds[0]?.body ?? null,
      }),
    );
    if (fiveHundreds.length > 0) exitCode = 1;
  }
} finally {
  await pool.end();
  await app.close();
}
process.exit(exitCode);
