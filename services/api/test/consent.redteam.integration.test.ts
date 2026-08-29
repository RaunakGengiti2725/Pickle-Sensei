import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

/**
 * Wave D3 red-team suite (D3-08) against the C10 consent architecture, run
 * on the real Fastify routes + real PostgreSQL. Every scenario is a break
 * that was found (or probed) during red-teaming:
 *
 * RT-1  Legacy privacy-center revoke bypassed the consent ledger, so the
 *       training gate kept treating the user as consented (FIXED).
 * RT-2  Duplicate grants: repeated grants append (no dedupe) but never
 *       corrupt derived status or the audit trail.
 * RT-3  Withdraw-then-regrant keeps the full audit trail and does NOT
 *       resurrect dataset items flagged for removal review.
 * RT-4  Consent version upgrade mid-session: a re-grant under a new version
 *       supersedes the old grant; withdrawal records the version withdrawn.
 * RT-5  A consent_subject row with zero model_training records is default
 *       deny — presence of the mapping row is never consent.
 * RT-6  Concurrent grant/withdraw requests: the ledger stays append-only
 *       and derived status matches the seq-latest record.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "consent-redteam-secret-0123456789";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

interface StatusBody {
  subjectPseudonym: string | null;
  scopes: Array<{
    scope: string;
    active: boolean;
    consentVersion: string | null;
    lastAction: string | null;
  }>;
  records: Array<{ scope: string; action: string; consentVersion: string; seq?: number }>;
}

describe.skipIf(!testUrl)("consent red-team (real Fastify + PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;

  const tokens = new Map<string, string>();
  const userIds = new Map<string, string>();

  async function makeUser(subject: string): Promise<void> {
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    const token = await minter.mint(subject);
    tokens.set(subject, token);
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    userIds.set(subject, (bootstrap.json() as { user: { id: string } }).user.id);
  }

  const headers = (subject: string) => ({ authorization: `Bearer ${tokens.get(subject)!}` });

  async function grant(subject: string, version = "model-training-v1") {
    return app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(subject),
      payload: {
        scope: "model_training",
        consentVersion: version,
        source: "mobile_settings",
        captureMode: "all_captures",
      },
    });
  }

  async function withdraw(subject: string) {
    return app.inject({
      method: "POST",
      url: "/v1/me/consent/withdraw",
      headers: headers(subject),
      payload: { scope: "model_training", source: "mobile_settings" },
    });
  }

  async function status(subject: string): Promise<StatusBody> {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/consent/status",
      headers: headers(subject),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as StatusBody;
  }

  /** The training gate's latest-consent query, verbatim semantics. */
  async function gateSaysConsented(userId: string): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT cr.action
       FROM consent_subject cs
       JOIN consent_record cr ON cr.subject_pseudonym = cs.pseudonym
       WHERE cr.scope = 'model_training' AND cs.user_id = $1
       ORDER BY cr.seq DESC LIMIT 1`,
      [userId],
    );
    return rows[0]?.action === "granted";
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);

    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      databaseUrl: testUrl!,
      devAuthSecret: DEV_SECRET,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    for (const s of [
      "auth0|rt-legacy-revoke",
      "auth0|rt-dup-grant",
      "auth0|rt-regrant",
      "auth0|rt-version",
      "auth0|rt-empty-subject",
      "auth0|rt-concurrent",
    ])
      await makeUser(s);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("RT-1: privacy-center revoke reaches the ledger — the training gate must deny", async () => {
    const subject = "auth0|rt-legacy-revoke";
    const userId = userIds.get(subject)!;
    expect((await grant(subject)).statusCode).toBe(200);
    expect(await gateSaysConsented(userId)).toBe(true);

    const revoke = await app.inject({
      method: "PUT",
      url: "/v1/me/ml-training-consent",
      headers: headers(subject),
      payload: { granted: false, termsVersion: "v1" },
    });
    expect(revoke.statusCode).toBe(200);

    // The break: before the fix the ledger still said 'granted' here and
    // any dataset item added after this point was training-eligible.
    expect(await gateSaysConsented(userId)).toBe(false);
    const body = await status(subject);
    const training = body.scopes.find((s) => s.scope === "model_training")!;
    expect(training.active).toBe(false);
    expect(training.lastAction).toBe("withdrawn");
    const last = body.records.at(-1)!;
    expect(last.action).toBe("withdrawn");
    expect(last.consentVersion).toBe("model-training-v1");
  });

  it("RT-2: duplicate grants append without corrupting status; every row is auditable", async () => {
    const subject = "auth0|rt-dup-grant";
    for (let i = 0; i < 3; i++) expect((await grant(subject)).statusCode).toBe(200);
    const body = await status(subject);
    expect(body.scopes.find((s) => s.scope === "model_training")!.active).toBe(true);
    const trainingRecords = body.records.filter((r) => r.scope === "model_training");
    expect(trainingRecords).toHaveLength(3);
    expect(trainingRecords.every((r) => r.action === "granted")).toBe(true);
    const audits = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = $1 AND action = 'consent.model_training.granted'",
      [userIds.get(subject)!],
    );
    expect(audits.rows[0].n).toBe(3);
  });

  it("RT-3: withdraw-then-regrant keeps the trail and does not resurrect removed items", async () => {
    const subject = "auth0|rt-regrant";
    const userId = userIds.get(subject)!;
    expect((await grant(subject)).statusCode).toBe(200);
    await pool.query(
      "INSERT INTO ml_dataset_item (source_user_id, consent_version) VALUES ($1, 'model-training-v1')",
      [userId],
    );
    expect((await withdraw(subject)).statusCode).toBe(200);
    const removed = await pool.query(
      "SELECT removed_at FROM ml_dataset_item WHERE source_user_id = $1",
      [userId],
    );
    expect(removed.rows[0].removed_at).not.toBeNull();

    expect((await grant(subject)).statusCode).toBe(200);
    const body = await status(subject);
    expect(body.scopes.find((s) => s.scope === "model_training")!.active).toBe(true);
    expect(body.records.filter((r) => r.scope === "model_training").map((r) => r.action)).toEqual([
      "granted",
      "withdrawn",
      "granted",
    ]);
    // Regrant must NOT quietly restore items already flagged for removal review.
    const after = await pool.query(
      "SELECT removed_at FROM ml_dataset_item WHERE source_user_id = $1",
      [userId],
    );
    expect(after.rows[0].removed_at).not.toBeNull();
  });

  it("RT-4: consent version upgrade mid-session supersedes; withdrawal names the withdrawn version", async () => {
    const subject = "auth0|rt-version";
    expect((await grant(subject, "model-training-v1")).statusCode).toBe(200);
    expect((await grant(subject, "model-training-v2")).statusCode).toBe(200);
    let body = await status(subject);
    expect(body.scopes.find((s) => s.scope === "model_training")!.consentVersion).toBe(
      "model-training-v2",
    );
    expect((await withdraw(subject)).statusCode).toBe(200);
    body = await status(subject);
    const last = body.records.at(-1)!;
    expect(last.action).toBe("withdrawn");
    expect(last.consentVersion).toBe("model-training-v2");
  });

  it("RT-5: a consent_subject row with zero training records stays default deny", async () => {
    const subject = "auth0|rt-empty-subject";
    const userId = userIds.get(subject)!;
    // Create the mapping row only (e.g. via a video_analysis grant).
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(subject),
      payload: {
        scope: "video_analysis",
        consentVersion: "video-analysis-v1",
        source: "onboarding",
        captureMode: "all_captures",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(await gateSaysConsented(userId)).toBe(false);
    const body = await status(subject);
    expect(body.scopes.find((s) => s.scope === "model_training")!.active).toBe(false);
    expect(body.scopes.find((s) => s.scope === "model_training")!.lastAction).toBeNull();
  });

  it("RT-6: concurrent grant + withdraw stays append-only; status matches seq-latest", async () => {
    const subject = "auth0|rt-concurrent";
    expect((await grant(subject)).statusCode).toBe(200);
    const results = await Promise.all([
      grant(subject),
      withdraw(subject),
      grant(subject),
      withdraw(subject),
    ]);
    for (const r of results) expect(r.statusCode).toBe(200);
    const body = await status(subject);
    const trainingRecords = body.records.filter((r) => r.scope === "model_training");
    expect(trainingRecords).toHaveLength(5);
    const seqs = trainingRecords.map((r) => r.seq!);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const lastBySeq = trainingRecords.at(-1)!;
    const derived = body.scopes.find((s) => s.scope === "model_training")!;
    expect(derived.active).toBe(lastBySeq.action === "granted");
    expect(derived.lastAction).toBe(lastBySeq.action);
  });

  it("seq is exposed on ledger records so clients can order deterministically", async () => {
    const body = await status("auth0|rt-dup-grant");
    for (const r of body.records) expect(typeof r.seq).toBe("number");
  });
});
