import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  DELETION_TASK_WINDOW,
  processDeletionTasks,
  sweepDeletedMedia,
  type WorkerDeps,
} from "../../src/worker.js";

/**
 * INT-deletion-managed-media adversary (attacked HEAD 30a40650).
 *
 * Real-PostgreSQL attacks on the account-deletion executor and the deleted-media
 * reconciliation sweep:
 *  - ADV-W01 owner isolation + inventory larger than every cap (window 20 /
 *    sweep 50): one media_purge task must erase EVERY object of the deleted
 *    owner and NONE of a neighbouring owner.
 *  - ADV-W02 reconciliation sweep starvation: a page cap (LIMIT 50) with no
 *    ordering and permanently failing rows must not starve newer deleted media
 *    forever (an orphaned object of deleted media is retained data).
 *  - ADV-W03 referenced originals: a catalog row (drill_instructional_media /
 *    pro_reference) that references an asset owned by the account being deleted
 *    must not lose the shared original, and the deletion must still terminate.
 *
 * Tests are read-only against production code: they only observe HEAD.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

interface RecordingStore {
  keys: Set<string>;
  deleted: string[];
  poisonPrefix: string | null;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string): Promise<string[]>;
}

function recordingStore(poisonPrefix: string | null = null): RecordingStore {
  const store: RecordingStore = {
    keys: new Set<string>(),
    deleted: [],
    poisonPrefix,
    async deleteObject(key) {
      if (store.poisonPrefix && key.startsWith(store.poisonPrefix)) {
        throw new Error(`AccessDenied on ${key}`);
      }
      store.deleted.push(key);
      store.keys.delete(key);
    },
    async listObjects(prefix) {
      return [...store.keys].filter((key) => key.startsWith(prefix));
    },
  };
  return store;
}

describe.skipIf(!testUrl)("ADV media-worker deletion & managed media (real PostgreSQL)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  function deps(store: RecordingStore | null): WorkerDeps {
    return {
      pool,
      queue: new InMemoryJobQueue(),
      objectStore: store,
      transcoder: null,
      log: () => {},
    };
  }

  async function createUser(tag: string, deleted = false): Promise<string> {
    const { rows } = await pool.query(
      deleted
        ? "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, 'deleted', now()) RETURNING id"
        : "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`auth0|adv-${tag}-${randomUUID()}`],
    );
    return rows[0].id as string;
  }

  async function insertAsset(input: {
    ownerId: string;
    objectKey: string;
    kind?: string;
    deleted?: boolean;
  }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, $2, 'b', $3, $4, CASE WHEN $5 THEN now() ELSE NULL END) RETURNING id`,
      [
        input.ownerId,
        input.kind ?? "raw_video",
        input.objectKey,
        input.deleted ? "deleted" : "ready",
        input.deleted ?? false,
      ],
    );
    return rows[0].id as string;
  }

  async function enqueue(userId: string, kinds: string[]): Promise<void> {
    for (const kind of kinds) {
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, $2, clock_timestamp())",
        [userId, kind],
      );
    }
  }

  async function taskStatuses(
    userId: string,
  ): Promise<Array<{ kind: string; status: string; attempts: number }>> {
    const { rows } = await pool.query(
      "SELECT kind, status, attempts FROM deletion_task WHERE user_id = $1 ORDER BY kind",
      [userId],
    );
    return rows as Array<{ kind: string; status: string; attempts: number }>;
  }

  it("ADV-W01 media_purge erases every object of the deleted owner (inventory > every cap) and none of a neighbour", async () => {
    const store = recordingStore();
    const victim = await createUser("victim", true);
    const neighbour = await createUser("neighbour");
    const inventory = Math.max(DELETION_TASK_WINDOW, 50) + 25;
    const victimKeys: string[] = [];
    for (let i = 0; i < inventory; i++) {
      const key = `media/${victim}/${randomUUID()}`;
      victimKeys.push(key);
      store.keys.add(key);
      store.keys.add(`${key}/normalized.mp4`);
      store.keys.add(`${key}/thumb.jpg`);
      await insertAsset({ ownerId: victim, objectKey: key });
    }
    // Neighbour keys deliberately share the victim's key as a string prefix
    // (no '/' separator) to probe prefix-based derived-artifact listing.
    const neighbourKeys = [
      `media/${neighbour}/${randomUUID()}`,
      `${victimKeys[0]}-neighbour-lookalike`,
    ];
    for (const key of neighbourKeys) {
      store.keys.add(key);
      await insertAsset({ ownerId: neighbour, objectKey: key });
    }
    await enqueue(victim, ["media_purge", "final_hard_delete"]);

    await processDeletionTasks(deps(store));
    await processDeletionTasks(deps(store));

    for (const key of victimKeys) {
      expect(store.keys.has(key)).toBe(false);
      expect(store.keys.has(`${key}/normalized.mp4`)).toBe(false);
      expect(store.keys.has(`${key}/thumb.jpg`)).toBe(false);
    }
    for (const key of neighbourKeys) expect(store.keys.has(key)).toBe(true);
    const neighbourRows = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 AND object_key IS NOT NULL AND deleted_at IS NULL",
      [neighbour],
    );
    expect(neighbourRows.rows[0].n).toBe(neighbourKeys.length);
    const remainingVictimRows = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1",
      [victim],
    );
    expect(remainingVictimRows.rows[0].n).toBe(0);
    expect((await taskStatuses(victim)).every((t) => t.status === "done")).toBe(true);
  });

  it("ADV-W02 sweep: 50 permanently failing rows must not starve a newer deleted asset past the page cap", async () => {
    const poisonPrefix = `media/poison-${randomUUID()}/`;
    const store = recordingStore(poisonPrefix);
    const owner = await createUser("sweep-owner");
    const poisonIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const key = `${poisonPrefix}${i}`;
      store.keys.add(key);
      poisonIds.push(await insertAsset({ ownerId: owner, objectKey: key, deleted: true }));
    }
    const freshKey = `media/${owner}/fresh-${randomUUID()}`;
    store.keys.add(freshKey);
    const freshId = await insertAsset({ ownerId: owner, objectKey: freshKey, deleted: true });

    // Bound: every eligible row is attempted within ceil(eligible / 50) + 1 sweeps.
    for (let cycle = 0; cycle < 3; cycle++) {
      await sweepDeletedMedia(deps(store));
    }

    const fresh = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [freshId]);
    expect(store.keys.has(freshKey)).toBe(false);
    expect(fresh.rows[0].object_key).toBeNull();

    // Cleanup for later tests: poison rows must not leak into other attacks.
    await pool.query("DELETE FROM media_asset WHERE id = ANY($1::uuid[])", [poisonIds]);
  });

  it("ADV-W03a account deletion must not destroy an original still referenced by the catalog", async () => {
    const store = recordingStore();
    const coach = await createUser("coach", true);
    const originalKey = `media/${coach}/${randomUUID()}`;
    store.keys.add(originalKey);
    const assetId = await insertAsset({
      ownerId: coach,
      objectKey: originalKey,
      kind: "drill_video",
    });
    const drill = await pool.query(
      "INSERT INTO drill (slug, title) VALUES ($1, 'ADV drill') RETURNING id",
      [`adv-drill-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO drill_instructional_media (
         drill_id, media_asset_id, source_url,
         creator_name, license_name, attribution,
         rights_status, rights_reviewed_at, rights_review_reference,
         coach_status, coach_reviewed_at, coach_review_reference, active
       ) VALUES (
         $1, $2, 'hosted://adv',
         'ADV Coach', 'CC-BY', 'ADV attribution',
         'approved', now(), 'ADV-rights-1',
         'approved', now(), 'ADV-coach-1', true
       )`,
      [drill.rows[0].id, assetId],
    );
    await enqueue(coach, ["media_purge"]);

    await processDeletionTasks(deps(store));

    const reference = await pool.query(
      "SELECT media_asset_id FROM drill_instructional_media WHERE drill_id = $1",
      [drill.rows[0].id],
    );
    const original = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
      assetId,
    ]);
    // A catalog row still points at this asset: its object must survive.
    expect(store.keys.has(originalKey)).toBe(true);
    expect(original.rows[0].object_key).toBe(originalKey);
    expect(reference.rows[0].media_asset_id).toBe(assetId);
  });

  it("ADV-W03b account deletion terminates (no permanently failed task) when pro_reference points at the user's media", async () => {
    const store = recordingStore();
    const athlete = await createUser("athlete", true);
    const key = `media/${athlete}/${randomUUID()}`;
    store.keys.add(key);
    const assetId = await insertAsset({
      ownerId: athlete,
      objectKey: key,
      kind: "reference_video",
    });
    const shotType = await pool.query("SELECT id FROM shot_type ORDER BY display_order LIMIT 1");
    await pool.query(
      `INSERT INTO pro_reference (athlete_name, shot_type_id, media_asset_id, license)
       VALUES ('ADV Athlete', $1, $2, 'CC-BY')`,
      [shotType.rows[0].id, assetId],
    );
    await enqueue(athlete, ["media_purge", "final_hard_delete"]);

    for (let cycle = 0; cycle < DELETION_TASK_MAX_ATTEMPTS + 2; cycle++) {
      await processDeletionTasks(deps(store));
    }

    const tasks = await taskStatuses(athlete);
    const stuck = tasks.filter((t) => t.status !== "done");
    expect(stuck).toEqual([]);
    const user = await pool.query("SELECT id FROM app_user WHERE id = $1", [athlete]);
    expect(user.rowCount).toBe(0);
  });
});
