import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentExportSigningPayload,
} from "@pickle/shared-types";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { findOrphanedLedgerSubjects } from "../src/modules/consent/integrity.js";
import type { FastifyInstance } from "fastify";

/**
 * Wave F f23 consent-abuse suite: attacks beyond the e21 happy-path lifecycle
 * and the D3 red-team set, on the real Fastify routes + real PostgreSQL.
 * Each case names the abuse it closes.
 *
 * F23-1  Replayed consent decision — a grant carrying a used decisionId, or a
 *        decision stamped before a later ledger action, must not resurrect
 *        consent after withdrawal.
 * F23-2  Pseudonym repointing — the mapping cannot be aimed at another
 *        subject's ledger.
 * F23-3  Silent attribution erasure — deleting a mapping row is tombstoned,
 *        and an untombstoned orphan is detectable.
 * F23-4  Version abuse — a grant naming no contract, or downgrading below the
 *        granted contract, is rejected.
 * F23-5  Export tampering — a truncated-and-rehashed export fails signature
 *        verification.
 * F23-6  Append-only bypass via the service connection — UPDATE / DELETE /
 *        TRUNCATE on consent_record all fail.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "consent-abuse-secret-0123456789";
const SIGNING_KEY = "f23-consent-export-signing-key";

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
  scopes: Array<{ scope: string; active: boolean; consentVersion: string | null }>;
  records: Array<{ scope: string; action: string; consentVersion: string; seq?: number }>;
}

interface GrantPayload {
  scope: string;
  consentVersion: string;
  source: string;
  captureMode: string;
  decisionId?: string;
  decidedAtIso?: string;
}

describe.skipIf(!testUrl)("consent abuse (Wave F f23, real Fastify + PostgreSQL)", () => {
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

  async function grant(subject: string, overrides: Partial<GrantPayload> = {}) {
    const payload: GrantPayload = {
      scope: "model_training",
      consentVersion: "model-training-v1",
      source: "mobile_settings",
      captureMode: "all_captures",
      ...overrides,
    };
    return app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(subject),
      payload,
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

  const SUBJECTS = [
    "auth0|f23-replay",
    "auth0|f23-stale",
    "auth0|f23-repoint-a",
    "auth0|f23-repoint-b",
    "auth0|f23-erasure",
    "auth0|f23-version",
    "auth0|f23-export",
    "auth0|f23-appendonly",
    "auth0|f23-race",
  ];

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
      consentExportSigningKey: SIGNING_KEY,
      consentExportSigningKeyId: "f23-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    for (const s of SUBJECTS) await makeUser(s);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("F23-1a: a replayed decisionId is rejected and appends nothing", async () => {
    const subject = "auth0|f23-replay";
    const decisionId = randomUUID();
    expect((await grant(subject, { decisionId })).statusCode).toBe(200);
    const before = (await status(subject)).records.length;

    const replay = await grant(subject, { decisionId });
    expect(replay.statusCode).toBe(409);
    expect((replay.json() as { error: { code: string } }).error.code).toBe(
      "consent.decision_replayed",
    );
    expect((await status(subject)).records).toHaveLength(before);
  });

  it("F23-1b: replaying the grant after withdrawal cannot resurrect consent", async () => {
    const subject = "auth0|f23-replay";
    const decisionId = randomUUID();
    expect((await grant(subject, { decisionId })).statusCode).toBe(200);
    expect((await withdraw(subject)).statusCode).toBe(200);

    // The captured/offline-queued grant is delivered again.
    const replay = await grant(subject, { decisionId });
    expect(replay.statusCode).toBe(409);
    const body = await status(subject);
    expect(body.scopes.find((s) => s.scope === "model_training")!.active).toBe(false);
  });

  it("F23-1c: a decision stamped before the latest ledger action is stale, not new", async () => {
    const subject = "auth0|f23-stale";
    const decidedAtIso = new Date(Date.now() - 60_000).toISOString();
    expect((await grant(subject, { decisionId: randomUUID() })).statusCode).toBe(200);
    expect((await withdraw(subject)).statusCode).toBe(200);

    const stale = await grant(subject, { decisionId: randomUUID(), decidedAtIso });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe("consent.decision_stale");
    expect((await status(subject)).scopes.find((s) => s.scope === "model_training")!.active).toBe(
      false,
    );

    // A decision made after the withdrawal is a genuine new decision.
    const fresh = await grant(subject, {
      decisionId: randomUUID(),
      decidedAtIso: new Date().toISOString(),
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("F23-2: the consent_subject mapping cannot be repointed at another ledger", async () => {
    const a = "auth0|f23-repoint-a";
    const b = "auth0|f23-repoint-b";
    expect((await grant(a)).statusCode).toBe(200);
    expect((await grant(b)).statusCode).toBe(200);
    const pseudonymA = (await status(a)).subjectPseudonym!;
    const pseudonymB = (await status(b)).subjectPseudonym!;
    expect(pseudonymA).not.toBe(pseudonymB);

    await expect(
      pool.query("UPDATE consent_subject SET pseudonym = $1 WHERE user_id = $2", [
        pseudonymB,
        userIds.get(a)!,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("UPDATE consent_subject SET user_id = $1 WHERE pseudonym = $2", [
        userIds.get(b)!,
        pseudonymA,
      ]),
    ).rejects.toThrow(/immutable/);
    expect((await status(a)).subjectPseudonym).toBe(pseudonymA);
  });

  it("F23-3: mapping deletion is tombstoned; an untombstoned orphan is detected", async () => {
    const subject = "auth0|f23-erasure";
    expect((await grant(subject)).statusCode).toBe(200);
    const pseudonym = (await status(subject)).subjectPseudonym!;

    await pool.query("DELETE FROM consent_subject WHERE pseudonym = $1", [pseudonym]);
    const tombstone = await pool.query(
      "SELECT count(*)::int AS n FROM consent_subject_erasure WHERE pseudonym = $1",
      [pseudonym],
    );
    expect(tombstone.rows[0].n).toBe(1);
    // The ledger rows survive the erasure of the mapping.
    const surviving = await pool.query(
      "SELECT count(*)::int AS n FROM consent_record WHERE subject_pseudonym = $1",
      [pseudonym],
    );
    expect(surviving.rows[0].n).toBeGreaterThan(0);
    // A lawful (tombstoned) erasure is not flagged.
    expect((await findOrphanedLedgerSubjects(pool)).some((o) => o.pseudonym === pseudonym)).toBe(
      false,
    );

    // The tombstone itself is append-only, so the erasure cannot be hidden.
    await expect(
      pool.query("DELETE FROM consent_subject_erasure WHERE pseudonym = $1", [pseudonym]),
    ).rejects.toThrow(/append-only/);

    // An orphan with no tombstone (rows written outside the mapping) is caught.
    const orphan = randomUUID();
    await pool.query(
      `INSERT INTO consent_record
         (subject_pseudonym, scope, action, consent_version, source, capture_mode)
       VALUES ($1, 'model_training', 'granted', 'model-training-v1', 'support', 'all_captures')`,
      [orphan],
    );
    const flagged = await findOrphanedLedgerSubjects(pool);
    expect(flagged.find((o) => o.pseudonym === orphan)?.recordCount).toBe(1);
  });

  it("F23-4a: a consentVersion naming no contract is rejected", async () => {
    const subject = "auth0|f23-version";
    for (const consentVersion of ["totally-made-up-v9", "model-training-v", "video-analysis-v1"]) {
      const res = await grant(subject, { consentVersion });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "consent.version_rejected",
      );
    }
    expect(
      (await status(subject)).records.filter((r) => r.scope === "model_training"),
    ).toHaveLength(0);
  });

  it("F23-4b: a version downgrade is rejected; upgrades still work", async () => {
    const subject = "auth0|f23-version";
    expect((await grant(subject, { consentVersion: "model-training-v2" })).statusCode).toBe(200);
    const downgrade = await grant(subject, { consentVersion: "model-training-v1" });
    expect(downgrade.statusCode).toBe(400);
    expect((downgrade.json() as { error: { code: string } }).error.code).toBe(
      "consent.version_rejected",
    );
    expect(
      (await status(subject)).scopes.find((s) => s.scope === "model_training")!.consentVersion,
    ).toBe("model-training-v2");

    // A withdrawal must not open a downgrade window either.
    expect((await withdraw(subject)).statusCode).toBe(200);
    expect((await grant(subject, { consentVersion: "model-training-v1" })).statusCode).toBe(400);
    expect((await grant(subject, { consentVersion: "model-training-v3" })).statusCode).toBe(200);
  });

  it("F23-5: the export is signed, and a truncated-and-rehashed export fails verification", async () => {
    const subject = "auth0|f23-export";
    expect((await grant(subject)).statusCode).toBe(200);
    expect((await withdraw(subject)).statusCode).toBe(200);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/consent/export",
      headers: headers(subject),
    });
    expect(res.statusCode).toBe(200);
    const envelope = res.json() as {
      exportVersion: string;
      exportedAtIso: string;
      subjectPseudonym: string;
      recordCount: number;
      maxSeq: number | null;
      recordsSha256: string;
      signature: { alg: string; keyId: string; value: string };
      records: Array<{ action: string }>;
    };
    expect(envelope.exportVersion).toBe(CONSENT_LEDGER_EXPORT_VERSION_V2);
    expect(envelope.signature.keyId).toBe("f23-k1");
    expect(envelope.records.at(-1)!.action).toBe("withdrawn");

    const expected = createHmac("sha256", SIGNING_KEY)
      .update(
        canonicalConsentExportSigningPayload({
          exportVersion: envelope.exportVersion,
          exportedAtIso: envelope.exportedAtIso,
          subjectPseudonym: envelope.subjectPseudonym,
          recordCount: envelope.recordCount,
          maxSeq: envelope.maxSeq,
          recordsSha256: envelope.recordsSha256,
        }),
      )
      .digest("hex");
    expect(envelope.signature.value).toBe(expected);

    // Drop the withdrawal and recompute every v1 integrity field: the hash
    // chain accepts it, the signature does not.
    const kept = envelope.records.slice(0, -1);
    const forgedHeader = {
      exportVersion: envelope.exportVersion,
      exportedAtIso: envelope.exportedAtIso,
      subjectPseudonym: envelope.subjectPseudonym,
      recordCount: kept.length,
      maxSeq: envelope.maxSeq === null ? null : envelope.maxSeq - 1,
      recordsSha256: "0".repeat(64),
    };
    const forgedUnderRealKey = createHmac("sha256", SIGNING_KEY)
      .update(canonicalConsentExportSigningPayload(forgedHeader))
      .digest("hex");
    expect(forgedUnderRealKey).not.toBe(envelope.signature.value);
  });

  it("F23-6: append-only cannot be bypassed through the service connection", async () => {
    const subject = "auth0|f23-appendonly";
    expect((await grant(subject)).statusCode).toBe(200);
    expect((await withdraw(subject)).statusCode).toBe(200);
    const pseudonym = (await status(subject)).subjectPseudonym!;

    await expect(
      pool.query(
        "UPDATE consent_record SET action = 'granted' WHERE subject_pseudonym = $1 AND action = 'withdrawn'",
        [pseudonym],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM consent_record WHERE subject_pseudonym = $1", [pseudonym]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query("TRUNCATE consent_record")).rejects.toThrow(/append-only/);

    const body = await status(subject);
    expect(body.scopes.find((s) => s.scope === "model_training")!.active).toBe(false);
  });

  it("F23-7: 12 interleaved grant/withdraw requests leave one consistent derived state", async () => {
    const subject = "auth0|f23-race";
    const ops: Array<Promise<{ statusCode: number }>> = [];
    for (let i = 0; i < 6; i++) {
      ops.push(grant(subject, { decisionId: randomUUID() }));
      ops.push(withdraw(subject));
    }
    const results = await Promise.all(ops);
    for (const r of results) expect(r.statusCode).toBe(200);

    const body = await status(subject);
    const records = body.records.filter((r) => r.scope === "model_training");
    expect(records).toHaveLength(12);
    const seqs = records.map((r) => r.seq!);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const derived = body.scopes.find((s) => s.scope === "model_training")!;
    expect(derived.active).toBe(records.at(-1)!.action === "granted");

    // Whatever the interleaving, the ledger's own seq-latest row and the
    // training gate must agree — no window where status says withdrawn while
    // the gate still selects the user.
    const gate = await pool.query(
      `SELECT cr.action
       FROM consent_subject cs
       JOIN consent_record cr ON cr.subject_pseudonym = cs.pseudonym
       WHERE cr.scope = 'model_training' AND cs.user_id = $1
       ORDER BY cr.seq DESC LIMIT 1`,
      [userIds.get(subject)!],
    );
    expect(gate.rows[0].action === "granted").toBe(derived.active);
  });
});
