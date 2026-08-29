import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { ConsentLedgerExportResponse } from "@pickle/api-contracts";
import { checkConsentForSubject, loadConsentLedger } from "@pickle/first-party-intake";
import {
  selectTrainingEligibleItemsWithWatermark,
  verifyTrainingEligibility,
  type TrainingEligibleItem,
} from "@pickle/media-worker/trainingConsent";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

/**
 * Wave E consent E2E (e21): the full lifecycle across the real API, the real
 * training-eligibility gate, and the real intake consent check, on one
 * PostgreSQL ledger:
 *
 *   grant → dataset item becomes training-eligible → ledger export (integrity
 *   envelope) authorizes intake → version bump re-grant supersedes → withdrawal
 *   → retroactive exclusion (fresh selection, stale-batch re-verification,
 *   removal review) → re-export denies intake.
 *
 * Plus export integrity: a tampered, truncated, or miscounted export must be
 * rejected by the intake loader, never silently trusted.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "consent-e2e-secret-0123456789";
const schemaName = `consent_e2e_${process.pid}_${randomUUID().replaceAll("-", "")}`;

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

interface ExportBody {
  exportVersion: string;
  exportedAtIso: string;
  subjectPseudonym: string;
  recordCount: number;
  maxSeq: number | null;
  recordsSha256: string;
  records: Array<{
    scope: string;
    action: string;
    consentVersion: string;
    seq: number;
    subjectPseudonym: string;
  }>;
}

describe.skipIf(!testUrl)("consent lifecycle E2E (API + training gate + intake)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userToken: string;
  let userId: string;
  let itemId: string;
  let preWithdrawalBatch: TrainingEligibleItem[] = [];
  let tmp: string;

  const headers = () => ({ authorization: `Bearer ${userToken}` });

  async function exportLedger(): Promise<ExportBody> {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/consent/export",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportBody;
    // Contract-schema validation: the export is the shape intake consumes.
    expect(ConsentLedgerExportResponse.safeParse(body).success).toBe(true);
    return body;
  }

  function writeLedger(body: unknown): string {
    const path = join(tmp, `ledger-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(body, null, 2));
    return path;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "consent-e2e-"));
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);

    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      databaseUrl: scopedUrl,
      devAuthSecret: DEV_SECRET,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    userToken = await minter.mint("auth0|consent-e2e-user");
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: headers(),
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    userId = (bootstrap.json() as { user: { id: string } }).user.id;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  it("export before any ledger exists is a typed 404, never an empty grant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/consent/export",
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("consent.no_ledger");
  });

  it("STEP 1 — grant both scopes; a dataset item becomes training-eligible", async () => {
    for (const [scope, consentVersion] of [
      ["video_analysis", "video-analysis-v1"],
      ["model_training", "model-training-v1"],
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/me/consent/grant",
        headers: headers(),
        payload: {
          scope,
          consentVersion,
          source: "mobile_settings",
          device: "iPhone16,1",
          captureMode: "all_captures",
        },
      });
      expect(res.statusCode).toBe(200);
    }
    const inserted = await pool.query(
      "INSERT INTO ml_dataset_item (source_user_id, consent_version) VALUES ($1, 'model-training-v1') RETURNING id",
      [userId],
    );
    itemId = inserted.rows[0].id as string;

    const selection = await selectTrainingEligibleItemsWithWatermark(pool);
    const mine = selection.items.filter((i) => i.source_user_id === userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(itemId);
    expect(mine[0]!.grant_consent_version).toBe("model-training-v1");
    preWithdrawalBatch = mine;
  });

  it("STEP 2 — the ledger export envelope authorizes intake for this subject", async () => {
    const body = await exportLedger();
    expect(body.exportVersion).toBe("consent-ledger-export-v1");
    expect(body.recordCount).toBe(2);
    expect(body.records.map((r) => r.scope)).toEqual(["video_analysis", "model_training"]);

    const path = writeLedger(body);
    const records = loadConsentLedger(path);
    expect(records).toHaveLength(2);
    const check = checkConsentForSubject(records, body.subjectPseudonym);
    expect(check.ok).toBe(true);
    expect(check.videoAnalysisActive).toBe(true);
    expect(check.modelTrainingActive).toBe(true);
    expect(check.modelTrainingConsentVersion).toBe("model-training-v1");
  });

  it("STEP 3 — version bump: a v2 re-grant supersedes and is visible end to end", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(),
      payload: {
        scope: "model_training",
        consentVersion: "model-training-v2",
        source: "mobile_settings",
        captureMode: "all_captures",
      },
    });
    expect(res.statusCode).toBe(200);

    const selection = await selectTrainingEligibleItemsWithWatermark(pool);
    const mine = selection.items.filter((i) => i.source_user_id === userId);
    expect(mine[0]!.consent_version).toBe("model-training-v1"); // stamped at ingest
    expect(mine[0]!.grant_consent_version).toBe("model-training-v2"); // current authority

    const body = await exportLedger();
    const check = checkConsentForSubject(
      loadConsentLedger(writeLedger(body)),
      body.subjectPseudonym,
    );
    expect(check.modelTrainingConsentVersion).toBe("model-training-v2");
  });

  it("STEP 4 — withdrawal retroactively excludes the item everywhere", async () => {
    const watermarkBefore = (await selectTrainingEligibleItemsWithWatermark(pool)).consentWatermark;
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/withdraw",
      headers: headers(),
      payload: { scope: "model_training", source: "mobile_settings" },
    });
    expect(res.statusCode).toBe(200);

    // Fresh selection: gone. Stale pre-withdrawal batch: re-verification drops it.
    const after = await selectTrainingEligibleItemsWithWatermark(pool);
    expect(after.items.filter((i) => i.source_user_id === userId)).toHaveLength(0);
    expect(after.consentWatermark).toBeGreaterThan(watermarkBefore);
    expect(await verifyTrainingEligibility(pool, preWithdrawalBatch)).toHaveLength(0);

    // The item is flagged for removal review and a deletion task queued.
    const item = await pool.query("SELECT removed_at FROM ml_dataset_item WHERE id = $1", [itemId]);
    expect(item.rows[0].removed_at).not.toBeNull();
    const tasks = await pool.query(
      "SELECT count(*)::int AS n FROM deletion_task WHERE user_id = $1 AND kind = 'ml_dataset_review'",
      [userId],
    );
    expect(tasks.rows[0].n).toBeGreaterThanOrEqual(1);

    // An item ingested AFTER withdrawal must not become eligible either.
    await pool.query(
      "INSERT INTO ml_dataset_item (source_user_id, consent_version) VALUES ($1, 'model-training-v2')",
      [userId],
    );
    const post = await selectTrainingEligibleItemsWithWatermark(pool);
    expect(post.items.filter((i) => i.source_user_id === userId)).toHaveLength(0);
  });

  it("STEP 5 — the re-exported ledger denies intake with an explicit reason", async () => {
    const body = await exportLedger();
    expect(body.recordCount).toBe(4);
    expect(body.records.at(-1)!.action).toBe("withdrawn");
    expect(body.records.at(-1)!.consentVersion).toBe("model-training-v2");

    const check = checkConsentForSubject(
      loadConsentLedger(writeLedger(body)),
      body.subjectPseudonym,
    );
    expect(check.ok).toBe(false);
    expect(check.videoAnalysisActive).toBe(true); // scopes stay independent
    expect(check.modelTrainingActive).toBe(false);
    expect(check.errors.join("\n")).toContain("model_training consent is not active");
  });

  it("EXPORT INTEGRITY — tampered action is rejected by the intake loader", async () => {
    const body = await exportLedger();
    const tampered = structuredClone(body);
    tampered.records.at(-1)!.action = "granted";
    expect(() => loadConsentLedger(writeLedger(tampered))).toThrow(/recordsSha256/);
  });

  it("EXPORT INTEGRITY — truncating the withdrawal off the export is rejected", async () => {
    const body = await exportLedger();
    const truncated = structuredClone(body);
    truncated.records = truncated.records.slice(0, -1);
    expect(() => loadConsentLedger(writeLedger(truncated))).toThrow(
      /failed integrity verification/,
    );
  });

  it("EXPORT INTEGRITY — reordered records and lying recordCount are rejected", async () => {
    const body = await exportLedger();
    const reordered = structuredClone(body);
    reordered.records = [...reordered.records].reverse();
    expect(() => loadConsentLedger(writeLedger(reordered))).toThrow(/seq/);

    const miscounted = structuredClone(body);
    miscounted.recordCount = miscounted.recordCount + 1;
    expect(() => loadConsentLedger(writeLedger(miscounted))).toThrow(/recordCount/);
  });

  it("EXPORT INTEGRITY — an export under an unknown version is rejected, never softened", async () => {
    const body = await exportLedger();
    const wrongVersion = structuredClone(body) as unknown as Record<string, unknown>;
    wrongVersion.exportVersion = "consent-ledger-export-v0";
    expect(() => loadConsentLedger(writeLedger(wrongVersion))).toThrow(/exportVersion/);
  });

  it("EXPORT INTEGRITY — foreign-subject records inside the envelope are rejected", async () => {
    const body = await exportLedger();
    const foreign = structuredClone(body);
    foreign.subjectPseudonym = randomUUID();
    expect(() => loadConsentLedger(writeLedger(foreign))).toThrow(/subject/);
  });

  it("exports are pseudonymous and audited", async () => {
    const body = await exportLedger();
    expect(body.subjectPseudonym).not.toBe(userId);
    for (const r of body.records) expect(r.subjectPseudonym).not.toBe(userId);
    const raw = readFileSync(writeLedger(body), "utf8");
    expect(raw).not.toContain(userId);
    const audits = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = $1 AND action = 'consent.ledger.exported'",
      [userId],
    );
    expect(audits.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("GDPR data export includes the full first-party consent ledger", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/me/export", headers: headers() });
    expect(res.statusCode).toBe(200);
    const ledger = (
      res.json() as { data: { consentLedger: Array<{ scope: string; action: string }> } }
    ).data.consentLedger;
    expect(ledger).toHaveLength(4);
    expect(ledger.map((r) => `${r.scope}:${r.action}`)).toEqual([
      "video_analysis:granted",
      "model_training:granted",
      "model_training:granted",
      "model_training:withdrawn",
    ]);
  });
});
