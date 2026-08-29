import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { MEDIA_RETENTION_POLICY_V1 } from "@pickle/shared-types";
import {
  enforceMediaRetention,
  handleJob,
  runOnce,
  sweepDeletedMedia,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Retention-policy enforcement against a real PostgreSQL database (Wave I
 * i30). Asserts the sweep only deletes what the policy authorizes:
 *  - explicit expires_at always wins;
 *  - user_controlled kinds expire only under the OWNER's opt-in window;
 *  - fixed_window kinds expire after their window;
 *  - until_deleted kinds are never auto-expired;
 * and that expiry propagates: object purged, dataset items removed, audited.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

describe.skipIf(!testUrl)("media retention enforcement (real PostgreSQL)", () => {
  let pool: pg.Pool;
  let deps: WorkerDeps;
  let queue: InMemoryJobQueue;
  const objects = new Map<string, true>();
  const deletedKeys: string[] = [];
  let ownerWithWindow: string;
  let ownerWithoutWindow: string;

  async function createUser(subject: string, retentionDays: number | null): Promise<string> {
    const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      subject,
    ]);
    const id = user.rows[0].id as string;
    await pool.query(
      "INSERT INTO user_setting (user_id, local_video_retention_days) VALUES ($1, $2)",
      [id, retentionDays],
    );
    return id;
  }

  async function insertAsset(input: {
    ownerId: string | null;
    kind: string;
    ageDays: number;
    expiresAt?: string | null;
  }): Promise<{ id: string; objectKey: string }> {
    const objectKey = `media/test/${randomUUID()}`;
    objects.set(objectKey, true);
    const row = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, created_at, expires_at)
       VALUES ($1, $2, 'b', $3, 'ready', now() - make_interval(days => $4::int), $5)
       RETURNING id`,
      [input.ownerId, input.kind, objectKey, input.ageDays, input.expiresAt ?? null],
    );
    return { id: row.rows[0].id as string, objectKey };
  }

  async function assetState(id: string): Promise<{ status: string; object_key: string | null }> {
    const { rows } = await pool.query("SELECT status, object_key FROM media_asset WHERE id = $1", [
      id,
    ]);
    return rows[0] as { status: string; object_key: string | null };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    queue = new InMemoryJobQueue();
    deps = {
      pool,
      queue,
      objectStore: {
        deleteObject: async (key) => {
          objects.delete(key);
          deletedKeys.push(key);
        },
        listObjects: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
      },
      transcoder: null,
      log: () => {},
    };
    ownerWithWindow = await createUser("auth0|retention-window", 7);
    ownerWithoutWindow = await createUser("auth0|retention-forever", null);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  it("expires assets by the owner opt-in window, fixed windows, and explicit expires_at — nothing else", async () => {
    const expiredByWindow = await insertAsset({
      ownerId: ownerWithWindow,
      kind: "raw_video",
      ageDays: 8,
    });
    const freshWithinWindow = await insertAsset({
      ownerId: ownerWithWindow,
      kind: "raw_video",
      ageDays: 6,
    });
    const noWindowOldVideo = await insertAsset({
      ownerId: ownerWithoutWindow,
      kind: "raw_video",
      ageDays: 5000,
    });
    const expiredShare = await insertAsset({
      ownerId: ownerWithoutWindow,
      kind: "share_video",
      ageDays: 31,
    });
    const freshShare = await insertAsset({
      ownerId: ownerWithoutWindow,
      kind: "share_video",
      ageDays: 29,
    });
    const ancientDrill = await insertAsset({
      ownerId: null,
      kind: "drill_video",
      ageDays: 5000,
    });
    const explicitExpiry = await insertAsset({
      ownerId: ownerWithoutWindow,
      kind: "drill_video",
      ageDays: 1,
      expiresAt: "1970-01-01T00:00:00Z",
    });

    const expired = await enforceMediaRetention(deps, MEDIA_RETENTION_POLICY_V1);
    expect(expired).toBe(3);

    expect((await assetState(expiredByWindow.id)).status).toBe("deleted");
    expect((await assetState(expiredShare.id)).status).toBe("deleted");
    expect((await assetState(explicitExpiry.id)).status).toBe("deleted");
    expect((await assetState(freshWithinWindow.id)).status).toBe("ready");
    expect((await assetState(noWindowOldVideo.id)).status).toBe("ready");
    expect((await assetState(freshShare.id)).status).toBe("ready");
    expect((await assetState(ancientDrill.id)).status).toBe("ready");

    // Each expiry is audited with the policy version.
    const audits = await pool.query(
      "SELECT target_id, metadata FROM audit_log WHERE action = 'media.retention_expired'",
    );
    expect(new Set(audits.rows.map((r: { target_id: string }) => r.target_id))).toEqual(
      new Set([expiredByWindow.id, expiredShare.id, explicitExpiry.id]),
    );
    for (const row of audits.rows as Array<{ metadata: { policyVersion: string } }>) {
      expect(row.metadata.policyVersion).toBe("media-retention-v1");
    }

    // The deleted-media sweep purges the expired objects and only those.
    const swept = await sweepDeletedMedia(deps);
    expect(swept).toBe(3);
    expect(objects.has(expiredByWindow.objectKey)).toBe(false);
    expect(objects.has(expiredShare.objectKey)).toBe(false);
    expect(objects.has(explicitExpiry.objectKey)).toBe(false);
    expect(objects.has(freshWithinWindow.objectKey)).toBe(true);
    expect(objects.has(noWindowOldVideo.objectKey)).toBe(true);
    expect((await assetState(expiredByWindow.id)).object_key).toBe(null);

    // Re-running is idempotent: nothing left to expire or sweep.
    expect(await enforceMediaRetention(deps, MEDIA_RETENTION_POLICY_V1)).toBe(0);
    expect(await sweepDeletedMedia(deps)).toBe(0);
  });

  it("retention expiry propagates to ml_dataset_item via the purge path", async () => {
    const asset = await insertAsset({ ownerId: ownerWithWindow, kind: "raw_video", ageDays: 30 });
    const liveAsset = await insertAsset({
      ownerId: ownerWithWindow,
      kind: "raw_video",
      ageDays: 1,
    });
    const item = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
      [ownerWithWindow, asset.id],
    );
    const featureItem = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, feature_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
      [ownerWithWindow, asset.id],
    );
    const liveItem = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
      [ownerWithWindow, liveAsset.id],
    );

    const result = await runOnce(deps);
    expect(result.expired).toBe(1);
    expect(result.swept).toBe(1);

    const removed = await pool.query(
      "SELECT id, removed_at FROM ml_dataset_item WHERE id = ANY($1::uuid[])",
      [[item.rows[0].id, featureItem.rows[0].id, liveItem.rows[0].id]],
    );
    const byId = new Map(
      removed.rows.map((r: { id: string; removed_at: Date | null }) => [r.id, r.removed_at]),
    );
    expect(byId.get(item.rows[0].id as string)).not.toBe(null);
    expect(byId.get(featureItem.rows[0].id as string)).not.toBe(null);
    expect(byId.get(liveItem.rows[0].id as string)).toBe(null);
    expect(objects.has(asset.objectKey)).toBe(false);
    expect(objects.has(liveAsset.objectKey)).toBe(true);
  });

  it("media.purge refuses to touch a live asset and its dataset items", async () => {
    const live = await insertAsset({ ownerId: ownerWithoutWindow, kind: "raw_video", ageDays: 1 });
    const item = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
      [ownerWithoutWindow, live.id],
    );
    const outcome = await handleJob(deps, {
      id: "j-live",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: live.id },
    });
    expect(outcome.handled).toBe(true);
    expect(objects.has(live.objectKey)).toBe(true);
    const row = await pool.query("SELECT removed_at FROM ml_dataset_item WHERE id = $1", [
      item.rows[0].id,
    ]);
    expect(row.rows[0].removed_at).toBe(null);
  });
});
