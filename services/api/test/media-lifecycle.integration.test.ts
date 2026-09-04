import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { selectTrainingEligibleItems } from "@pickle/media-worker/trainingConsent";
import { runOnce, type WorkerDeps } from "@pickle/media-worker/worker";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { FakeObjectStore } from "./support/fakeObjectStore.js";

/**
 * Wave I i30: deletion-propagation across the whole media lifecycle, on a
 * real PostgreSQL database with the REAL worker consuming the queue the REAL
 * API dispatched to. Proves deletion reaches every required table/store:
 *
 *  - single-media deletion → object store (master + derived artifacts),
 *    media_asset.object_key, ml_dataset_item, training-eligibility gate,
 *    playback API, audit_log;
 *  - ML-consent withdrawal → consent_record ledger, ml_dataset_item,
 *    deletion_task review queue;
 *  - account deletion → app_user (hard delete), friendship, media_asset,
 *    object store, ml_dataset_item, user_setting/consent_subject (cascade),
 *    while consent_record (pseudonymous ledger) and audit_log are retained.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "media-lifecycle-secret-0123456789";
const schemaName = `media_lifecycle_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

describe.skipIf(!testUrl)("media deletion propagation (API + worker + PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let queue: InMemoryJobQueue;
  let store: FakeObjectStore;
  let workerDeps: WorkerDeps;
  let userToken: string;
  let userId: string;
  let friendId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
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
      devAuthSecret: secret,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    queue = new InMemoryJobQueue();
    store = new FakeObjectStore();
    app = buildApp(config, { queue, objectStore: store });
    // The worker consumes the SAME queue and object store the API used, so
    // propagation is exercised end-to-end, not simulated.
    workerDeps = {
      pool,
      queue,
      objectStore: {
        deleteObject: async (key) => store.deleteObject(key),
        listObjects: async (prefix) =>
          [...store.objects.keys()].filter((key) => key.startsWith(prefix)),
      },
      transcoder: null,
      log: () => {},
    };

    const minter = new DevTokenVerifier("test", secret);
    userToken = await minter.mint(`media-lifecycle|${randomUUID()}`);
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(userToken),
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    userId = (bootstrap.json() as { user: { id: string } }).user.id;
    const settings = await app.inject({
      method: "PATCH",
      url: "/v1/me/settings",
      headers: auth(userToken),
      payload: { cloudSyncEnabled: true },
    });
    expect(settings.statusCode).toBe(200);

    // Explicit model-training grant so dataset items are genuinely
    // training-eligible before deletion — proving the gate closes because of
    // DELETION propagation, not because consent was never active.
    const grant = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: auth(userToken),
      payload: {
        scope: "model_training",
        consentVersion: "model-training-v1",
        source: "mobile_settings",
        captureMode: "all_captures",
      },
    });
    expect(grant.statusCode, grant.body).toBe(200);

    const friend = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ('media-lifecycle|friend') RETURNING id",
    );
    friendId = friend.rows[0].id as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  async function uploadReadyAsset(): Promise<{ mediaAssetId: string; objectKey: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(userToken),
      payload: {
        kind: "raw_video",
        filename: "clip.mp4",
        bytes: 1024,
        contentType: "video/mp4",
        sha256: "a".repeat(64),
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const { mediaAssetId } = created.json() as { mediaAssetId: string };
    const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
      mediaAssetId,
    ]);
    const objectKey = row.rows[0].object_key as string;
    store.objects.set(objectKey, 1024);
    const completed = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    expect(completed.statusCode, completed.body).toBe(200);
    return { mediaAssetId, objectKey };
  }

  async function drainWorker(maxCycles = 6): Promise<void> {
    for (let i = 0; i < maxCycles; i++) {
      await runOnce(workerDeps);
    }
  }

  it("single media deletion reaches object store, dataset, training gate, playback, and audit", async () => {
    const { mediaAssetId, objectKey } = await uploadReadyAsset();
    // A derived artifact under the master prefix must be purged with it.
    const derivedKey = `${objectKey}/normalized.mp4`;
    store.objects.set(derivedKey, 512);
    const item = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
      [userId, mediaAssetId],
    );
    const itemId = item.rows[0].id as string;
    const eligibleBefore = await selectTrainingEligibleItems(pool);
    expect(eligibleBefore.map((i) => i.id)).toContain(itemId);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(userToken),
    });
    expect(del.statusCode).toBe(204);

    // Playback is refused immediately, before the object is even purged.
    const playback = await app.inject({
      method: "GET",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(userToken),
    });
    expect(playback.statusCode).toBe(404);

    await drainWorker();

    // Object store: master AND derived artifact gone.
    expect(store.objects.has(objectKey)).toBe(false);
    expect(store.objects.has(derivedKey)).toBe(false);
    expect(store.deletedKeys).toContain(objectKey);
    expect(store.deletedKeys).toContain(derivedKey);

    // media_asset: status deleted, object_key nulled, deleted_at stamped.
    const asset = await pool.query(
      "SELECT status, object_key, deleted_at FROM media_asset WHERE id = $1",
      [mediaAssetId],
    );
    expect(asset.rows[0].status).toBe("deleted");
    expect(asset.rows[0].object_key).toBe(null);
    expect(asset.rows[0].deleted_at).not.toBe(null);

    // ml_dataset_item: removed, and the training gate no longer selects it
    // even though model-training consent is still active.
    const removed = await pool.query("SELECT removed_at FROM ml_dataset_item WHERE id = $1", [
      itemId,
    ]);
    expect(removed.rows[0].removed_at).not.toBe(null);
    const eligibleAfter = await selectTrainingEligibleItems(pool);
    expect(eligibleAfter.map((i) => i.id)).not.toContain(itemId);

    // audit_log records the deletion request.
    const audit = await pool.query(
      "SELECT 1 FROM audit_log WHERE action = 'media.delete_requested' AND target_id = $1",
      [mediaAssetId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("ML-consent withdrawal propagates to the ledger, dataset items, and review queue", async () => {
    const { mediaAssetId } = await uploadReadyAsset();
    const item = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
      [userId, mediaAssetId],
    );
    const itemId = item.rows[0].id as string;
    expect((await selectTrainingEligibleItems(pool)).map((i) => i.id)).toContain(itemId);

    const revoke = await app.inject({
      method: "PUT",
      url: "/v1/me/ml-training-consent",
      headers: auth(userToken),
      payload: { granted: false, termsVersion: "model-training-v1" },
    });
    expect(revoke.statusCode, revoke.body).toBe(200);

    // Ledger: an appended model_training withdrawal for this subject.
    const ledger = await pool.query(
      `SELECT cr.action FROM consent_record cr
       JOIN consent_subject cs ON cs.pseudonym = cr.subject_pseudonym
       WHERE cs.user_id = $1 AND cr.scope = 'model_training'
       ORDER BY cr.seq DESC LIMIT 1`,
      [userId],
    );
    expect(ledger.rows[0].action).toBe("withdrawn");

    // Dataset: items flagged removed; gate selects nothing for this user.
    const removed = await pool.query("SELECT removed_at FROM ml_dataset_item WHERE id = $1", [
      itemId,
    ]);
    expect(removed.rows[0].removed_at).not.toBe(null);
    expect(
      (await selectTrainingEligibleItems(pool)).filter((i) => i.source_user_id === userId),
    ).toEqual([]);

    // Review queue: an ml_dataset_review deletion task was created.
    const task = await pool.query(
      "SELECT 1 FROM deletion_task WHERE user_id = $1 AND kind = 'ml_dataset_review'",
      [userId],
    );
    expect(task.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("account deletion propagates to every required table and store, retaining only the audited minimum", async () => {
    // Re-grant so a live dataset item exists at account-deletion time.
    const regrant = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: auth(userToken),
      payload: {
        scope: "model_training",
        consentVersion: "model-training-v1",
        source: "mobile_settings",
        captureMode: "all_captures",
      },
    });
    expect(regrant.statusCode, regrant.body).toBe(200);
    const { mediaAssetId, objectKey } = await uploadReadyAsset();
    const item = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
      [userId, mediaAssetId],
    );
    await pool.query(
      `INSERT INTO friendship (requester_user_id, addressee_user_id, status)
       VALUES ($1, $2, 'accepted')`,
      [userId, friendId],
    );
    const ledgerBefore = await pool.query("SELECT count(*)::int AS n FROM consent_record");

    const del = await app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: auth(userToken),
      payload: { confirmation: "DELETE" },
    });
    expect(del.statusCode, del.body).toBe(200);
    expect((del.json() as { status: string }).status).toBe("processing");

    await drainWorker();

    // app_user: hard-deleted (final_hard_delete ran once purge/review done).
    const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId]);
    expect(user.rowCount).toBe(0);

    // Object store: the user's object is gone.
    expect(store.objects.has(objectKey)).toBe(false);

    // media_asset / user_setting / consent_subject / friendship: removed
    // (cascade or explicit step).
    for (const [table, column] of [
      ["media_asset", "owner_user_id"],
      ["user_setting", "user_id"],
      ["consent_subject", "user_id"],
      ["friendship", "requester_user_id"],
    ] as const) {
      const rows = await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [userId]);
      expect(rows.rowCount, table).toBe(0);
    }

    // ml_dataset_item: the source_user link is severed (SET NULL on cascade)
    // and the item was flagged removed by the review task before that.
    const itemAfter = await pool.query(
      "SELECT source_user_id, removed_at FROM ml_dataset_item WHERE id = $1",
      [item.rows[0].id],
    );
    expect(itemAfter.rows[0].source_user_id).toBe(null);
    expect(itemAfter.rows[0].removed_at).not.toBe(null);

    // Retained minimum: the pseudonymous consent ledger survives untouched,
    // and the deletion request itself is audited.
    const ledgerAfter = await pool.query("SELECT count(*)::int AS n FROM consent_record");
    expect(ledgerAfter.rows[0].n).toBe(ledgerBefore.rows[0].n);
    const audit = await pool.query(
      "SELECT 1 FROM audit_log WHERE action = 'account.delete_requested' AND actor_user_id = $1",
      [userId],
    );
    expect(audit.rowCount).toBe(1);

    // Every deletion task is terminal; idp_revoke records honestly that no
    // IdP credentials were configured instead of lingering as an open row.
    const tasks = await pool.query(
      "SELECT kind, status, detail FROM deletion_task WHERE user_id = $1",
      [userId],
    );
    for (const row of tasks.rows as Array<{
      kind: string;
      status: string;
      detail: { skipped?: string };
    }>) {
      expect(row.status, row.kind).toBe("done");
      if (row.kind === "idp_revoke")
        expect(row.detail.skipped).toBe("idp credentials not configured");
    }
  });
});
