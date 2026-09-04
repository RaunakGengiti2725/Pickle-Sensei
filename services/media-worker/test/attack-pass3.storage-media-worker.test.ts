import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { QueueSloMonitor } from "@pickle/slo";
import {
  deletionBacklog,
  enforceMediaRetention,
  handleJob,
  processDeletionTasks,
  runOnce,
  sweepDeletedMedia,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";
import {
  isDatasetItemTrainingEligible,
  latestEligibilityEntries,
  recordTrainingEligibility,
  selectTrainingEligibleItems,
  verifyTrainingEligibility,
} from "../src/trainingConsent.js";

/**
 * Adversarial pass 3 (tester #2) — storage-media-worker, cloud plane, against a
 * REAL PostgreSQL database in an isolated schema. Each `it` block is one
 * attack scenario; the assertions pin the behaviour that HELD, and the
 * `ATTACK_EVIDENCE` console lines carry the measured values (counts,
 * timings, seeds) so the vitest log doubles as the evidence artifact.
 *
 * Scenarios (S1..S7 from the assignment, X* = extra):
 *  S1 idp_revoke + final_hard_delete only → app_user hard-deleted, idp_revoke
 *     stays queued/blocked, deletion_task has no FK to app_user.
 *  S2 1,000 share.render jobs → queue_stalled fires (jobsSeen>0,
 *     jobsHandled=0, oldestJobAgeMs grows) on the in-memory queue.
 *     (The SqsJobQueue half lives in attack-pass3.sqs.test.ts.)
 *  S3 media.process with another user's mediaAssetId → processed by id only.
 *  S4 media.purge {mediaAssetId:'not-a-uuid'} → pg cast error caught per job,
 *     job unacked, exactly one worker_failure{handler_exception}.
 *  S5 grant → select → withdraw → hard-DELETE media_asset (FK SET NULL) →
 *     verify excludes the item and the ledger says withdrawn.
 *  S6 hard-DELETE media_asset while the transcoder promise is pending →
 *     post-transcode UPDATE affects 0 rows, derived artifacts cleaned up.
 *  S7 500 expired share_video rows → enforceMediaRetention does 500 audit
 *     inserts + 500 enqueues within WORKER_INTERVAL_MS-scale time.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `attack_p3_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);
/** Default poll interval of services/media-worker/src/main.ts. */
const WORKER_INTERVAL_MS = Number(process.env["WORKER_INTERVAL_MS"] ?? 5000);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function evidence(scenario: string, data: Record<string, unknown>): void {
  console.log(`ATTACK_EVIDENCE ${JSON.stringify({ scenario, ...data })}`);
}

/** Deterministic PRNG (mulberry32) so any randomised input is reproducible. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class FakeStore implements ObjectDeleter {
  keys = new Set<string>();
  deletedKeys: string[] = [];
  async deleteObject(key: string): Promise<void> {
    this.keys.delete(key);
    this.deletedKeys.push(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

function makeSink(): { sink: IAnalyticsSink; tracked: AnalyticsEvent[] } {
  const tracked: AnalyticsEvent[] = [];
  return {
    tracked,
    sink: { track: (event) => void tracked.push(event), flush: async () => {} },
  };
}

describe.skipIf(!testUrl)(
  "attack pass 3: storage-media-worker (isolated PostgreSQL schema)",
  () => {
    let pool: pg.Pool;
    let adminPool: pg.Pool;

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName), max: 8 });
      await runMigrations(pool, migrationsDir);
      await seed(pool);
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    });

    async function createUser(subject: string): Promise<string> {
      const { rows } = await pool.query(
        "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
        [subject],
      );
      return rows[0].id as string;
    }

    async function insertAsset(fields: {
      ownerId: string;
      objectKey: string | null;
      status: string;
      kind?: string;
      deleted?: boolean;
      createdAt?: Date;
    }): Promise<string> {
      const row = await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at, created_at)
       VALUES ($1, $2, 'b', $3, $4, $5, COALESCE($6, now())) RETURNING id`,
        [
          fields.ownerId,
          fields.kind ?? "raw_video",
          fields.objectKey,
          fields.status,
          fields.deleted ? new Date() : null,
          fields.createdAt ?? null,
        ],
      );
      return row.rows[0].id as string;
    }

    async function appendConsent(
      userId: string,
      action: "granted" | "withdrawn",
      captureMode = "all_captures",
      version = "model-training-v1",
    ): Promise<void> {
      const subject = await pool.query(
        `INSERT INTO consent_subject (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = consent_subject.user_id
       RETURNING pseudonym`,
        [userId],
      );
      await pool.query(
        `INSERT INTO consent_record
         (subject_pseudonym, scope, action, consent_version, source, capture_mode)
       VALUES ($1, 'model_training', $2, $3, 'mobile_settings', $4)`,
        [subject.rows[0].pseudonym, action, version, captureMode],
      );
    }

    function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps & {
      store: FakeStore;
      queue: InMemoryJobQueue;
      tracked: AnalyticsEvent[];
      logs: string[];
    } {
      const store = new FakeStore();
      // Callers may hand in a (wrapped) in-memory queue; keep it, do not shadow it.
      const queue = (overrides.queue as InMemoryJobQueue | undefined) ?? new InMemoryJobQueue();
      const { sink, tracked } = makeSink();
      const logs: string[] = [];
      const deps: WorkerDeps = {
        pool,
        queue,
        objectStore: store,
        transcoder: null,
        log: (line) => void logs.push(line),
        analytics: sink,
        ...overrides,
      };
      return Object.assign(deps, { store, queue, tracked, logs });
    }

    // ───────────────────────────────────────────────────────────── S1 ──
    it("S1: idp_revoke + final_hard_delete only → app_user hard-deleted, idp_revoke stays queued/blocked, no FK", async () => {
      const uid = await createUser(`auth0|attack-s1-${randomUUID()}`);
      await pool.query("UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE id = $1", [
        uid,
      ]);
      // Personal rows that must cascade with the app_user row.
      await pool.query("INSERT INTO user_setting (user_id) VALUES ($1)", [uid]);
      await pool.query("INSERT INTO user_profile (user_id, display_name) VALUES ($1, 'S1')", [uid]);
      const idp = await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'idp_revoke', now() - interval '2 seconds') RETURNING id",
        [uid],
      );
      const fin = await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'final_hard_delete', now() - interval '1 second') RETURNING id",
        [uid],
      );
      const idpId = idp.rows[0].id as string;
      const finId = fin.rows[0].id as string;

      // Attack precondition: the schema really has no FK from deletion_task to app_user.
      const fks = await pool.query(
        `SELECT conname FROM pg_constraint
       WHERE conrelid = ($1 || '.deletion_task')::regclass AND contype = 'f'`,
        [schemaName],
      );
      expect(fks.rows).toHaveLength(0);

      const deps = makeDeps();
      const processed = await processDeletionTasks(deps);
      expect(processed).toBe(1); // only final_hard_delete completes

      const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [uid]);
      expect(user.rowCount).toBe(0);
      const setting = await pool.query("SELECT 1 FROM user_setting WHERE user_id = $1", [uid]);
      expect(setting.rowCount).toBe(0);
      const profile = await pool.query("SELECT 1 FROM user_profile WHERE user_id = $1", [uid]);
      expect(profile.rowCount).toBe(0);

      const tasks = await pool.query(
        "SELECT id, kind, status, detail, processed_at, attempts FROM deletion_task WHERE user_id = $1 ORDER BY created_at",
        [uid],
      );
      expect(tasks.rows).toHaveLength(2); // both rows survive the vanished user
      const idpRow = tasks.rows[0] as {
        id: string;
        status: string;
        detail: { blocked?: string };
        attempts: number;
      };
      const finRow = tasks.rows[1] as { id: string; status: string; processed_at: Date | null };
      expect(idpRow.id).toBe(idpId);
      expect(idpRow.status).toBe("queued");
      expect(idpRow.detail.blocked).toBe("idp credentials not configured");
      expect(idpRow.attempts).toBe(0);
      expect(finRow.id).toBe(finId);
      expect(finRow.status).toBe("done");
      expect(finRow.processed_at).not.toBeNull();

      // Rapid repeats: the orphaned idp_revoke is re-visited every cycle, never
      // throws, never completes, never counts as processed.
      for (let i = 0; i < 5; i++) expect(await processDeletionTasks(deps)).toBe(0);
      const again = await pool.query(
        "SELECT status, detail, attempts FROM deletion_task WHERE id = $1",
        [idpId],
      );
      expect(again.rows[0].status).toBe("queued");
      expect(again.rows[0].attempts).toBe(0);

      // The task carries NO identity to revoke: detail is only the blocked
      // marker and the auth_subject went away with app_user.
      const subjectLeft = await pool.query(
        "SELECT 1 FROM app_user WHERE auth_subject LIKE 'auth0|attack-s1-%'",
      );
      expect(subjectLeft.rowCount).toBe(0);
      expect(Object.keys(again.rows[0].detail as Record<string, unknown>)).toEqual(["blocked"]);

      // Backlog telemetry counts the orphan as pending forever.
      const backlog = await deletionBacklog(pool);
      expect(backlog).not.toBeNull();
      expect(backlog!.pending).toBeGreaterThanOrEqual(1);
      evidence("S1", {
        appUserRows: user.rowCount,
        idpStatus: again.rows[0].status,
        idpDetail: again.rows[0].detail,
        finalStatus: finRow.status,
        deletionTaskForeignKeys: fks.rows.length,
        backlogPending: backlog!.pending,
        backlogOldestAgeSeconds: backlog!.oldestAgeSeconds,
      });
    });

    // ───────────────────────────────────────────────────────────── S2 ──
    it("S2: 1,000 share.render jobs → queue_stalled (no_progress) fires on the in-memory queue with growing oldestJobAgeMs", async () => {
      const queue = new InMemoryJobQueue();
      const n = 1000;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await queue.enqueue("share.render", { shotId: `shot-${i}` });
      const enqueueMs = performance.now() - t0;
      expect(await queue.size()).toBe(n);

      const observations: Array<{
        depth: number;
        oldestJobAgeMs: number | null;
        jobsHandled: number;
        jobsSeen: number;
      }> = [];
      const monitor = new QueueSloMonitor({
        queue: "media",
        stalledAfterIdleCycles: 3,
        maxOldestJobAgeMs: null,
      });
      const observe = monitor.observe.bind(monitor);
      monitor.observe = (observation) => {
        observations.push(observation);
        return observe(observation);
      };
      const deps = makeDeps({ queue, sloMonitor: monitor });

      const alerts: Array<{ depth: number; oldestJobAgeMs?: number; cycle: number }> = [];
      const unhandledPerCycle: number[] = [];
      for (let cycle = 1; cycle <= 6; cycle++) {
        const result = await runOnce(deps);
        expect(result.jobs).toBe(0); // share.render is never handled (no ffmpeg)
        // Age must be measurable across cycles: make wall-clock progress.
        await new Promise((r) => setTimeout(r, 15));
        for (const event of deps.tracked.filter((e) => e.name === "queue_stalled")) {
          const stalled = event as { depth: number; oldestJobAgeMs?: number };
          alerts.push({
            depth: stalled.depth,
            cycle,
            ...(stalled.oldestJobAgeMs !== undefined
              ? { oldestJobAgeMs: stalled.oldestJobAgeMs }
              : {}),
          });
        }
        unhandledPerCycle.push(
          deps.tracked.filter(
            (e) =>
              e.name === "worker_failure" && "failureKind" in e && e.failureKind === "unhandled",
          ).length,
        );
        deps.tracked.length = 0;
      }
      expect(unhandledPerCycle).toEqual([10, 10, 10, 10, 10, 10]);
      expect(observations).toHaveLength(6);
      for (const o of observations) {
        expect(o.jobsSeen).toBe(10);
        expect(o.jobsHandled).toBe(0);
        expect(o.depth).toBeGreaterThan(0);
        expect(o.oldestJobAgeMs).not.toBeNull();
      }
      // Alerts start at cycle 3 and repeat every cycle after.
      expect(alerts.map((a) => a.cycle)).toEqual([3, 4, 5, 6]);
      for (let i = 1; i < alerts.length; i++) {
        expect(alerts[i]!.oldestJobAgeMs!).toBeGreaterThan(alerts[i - 1]!.oldestJobAgeMs!);
      }
      // Unhandled jobs are in flight (not lost): visible depth shrinks by 10
      // per cycle while every job stays accounted for.
      expect(observations.map((o) => o.depth)).toEqual([990, 980, 970, 960, 950, 940]);
      queue.expireInFlight();
      expect(await queue.size()).toBe(n);
      evidence("S2-inmemory", {
        jobs: n,
        enqueueMs: Number(enqueueMs.toFixed(1)),
        observations,
        alerts,
        unhandledPerCycle,
      });
    });

    it("S2b: one stuck job with the in-memory queue alerts only while it is visible (in-flight jobs hide from jobsSeen)", async () => {
      // Mirrors the SQS visibility-timeout semantics without expireInFlight():
      // after the first receive the job is in flight, receive() returns
      // nothing, jobsSeen=0 and depth=0 → the idle counter RESETS.
      const queue = new InMemoryJobQueue();
      await queue.enqueue("share.render", { shotId: "stuck" });
      const monitor = new QueueSloMonitor({
        queue: "media",
        stalledAfterIdleCycles: 3,
        maxOldestJobAgeMs: null,
      });
      const deps = makeDeps({ queue, sloMonitor: monitor });
      const idle: number[] = [];
      for (let cycle = 1; cycle <= 6; cycle++) {
        await runOnce(deps);
        idle.push(monitor.consecutiveIdleCycles());
      }
      const stalled = deps.tracked.filter((e) => e.name === "queue_stalled");
      evidence("S2b-inmemory-single-stuck", {
        idleCyclesPerCycle: idle,
        stalledAlerts: stalled.length,
      });
      // Documented gap: a single stuck job never trips no_progress because the
      // in-flight copy is invisible to size()/receive(); only the age-based
      // rule (maxOldestJobAgeMs, in-memory only) can catch it.
      expect(idle).toEqual([1, 0, 0, 0, 0, 0]);
      expect(stalled).toHaveLength(0);
    });

    // ───────────────────────────────────────────────────────────── S3 ──
    it("S3: media.process with ANOTHER user's mediaAssetId is processed by id only (no owner check)", async () => {
      const owner = await createUser(`auth0|attack-s3-owner-${randomUUID()}`);
      const attacker = await createUser(`auth0|attack-s3-attacker-${randomUUID()}`);
      const key = `media/${owner}/victim-${randomUUID()}`;
      const id = await insertAsset({ ownerId: owner, objectKey: key, status: "processing" });
      let transcodedKey: string | null = null;
      const deps = makeDeps({
        transcoder: async ({ objectKey }) => {
          transcodedKey = objectKey;
          return {
            normalizedKey: `${objectKey}/normalized.mp4`,
            thumbnailKey: `${objectKey}/thumb.jpg`,
          };
        },
      });
      // The payload has no actor field at all: the worker cannot know who asked.
      const outcome = await handleJob(deps, {
        id: "j-s3",
        kind: "media.process",
        payload: { mediaAssetId: id, requestedBy: attacker },
        attempt: 1,
      });
      expect(outcome.handled).toBe(true);
      expect(outcome.note).toMatch(/^normalized=/);
      expect(transcodedKey).toBe(key);
      const after = await pool.query(
        "SELECT status, owner_user_id FROM media_asset WHERE id = $1",
        [id],
      );
      expect(after.rows[0].status).toBe("ready");
      // Ownership is untouched; derived artifacts stay under the owner's prefix.
      expect(after.rows[0].owner_user_id).toBe(owner);
      expect(outcome.note).toContain(`normalized=${key}/normalized.mp4`);
      evidence("S3", {
        ownerCheck: "none (worker selects owner_user_id but never compares it)",
        payloadActorField: "absent from JobEnvelope payload",
        processedKey: transcodedKey,
        note: outcome.note,
      });
    });

    // ───────────────────────────────────────────────────────────── S4 ──
    it("S4: media.purge {mediaAssetId:'not-a-uuid'} → pg cast error caught, job unacked, exactly one worker_failure{handler_exception}", async () => {
      const deps = makeDeps();
      const live = await createUser(`auth0|attack-s4-${randomUUID()}`);
      const liveKey = `media/${live}/ok-${randomUUID()}`;
      const liveId = await insertAsset({
        ownerId: live,
        objectKey: liveKey,
        status: "deleted",
        deleted: true,
      });
      deps.store.keys.add(liveKey);
      // Poison first, then a valid purge: the batch must survive the poison.
      await deps.queue.enqueue("media.purge", { mediaAssetId: "not-a-uuid" });
      await deps.queue.enqueue("media.purge", { mediaAssetId: liveId });

      const result = await runOnce(deps);
      expect(result.jobs).toBe(1); // the valid purge was handled and acked
      expect(deps.store.keys.has(liveKey)).toBe(false);

      const failures = deps.tracked.filter((e) => e.name === "worker_failure") as Array<{
        jobKind: string;
        failureKind: string;
      }>;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        jobKind: "media.purge",
        failureKind: "handler_exception",
      });
      const thrown = deps.logs.find((l) => l.startsWith("media.purge: handler threw:"));
      expect(thrown).toMatch(/invalid input syntax for type uuid/);
      // Never a crash in runOnce: the pool is still healthy.
      expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);

      // Unacked: after visibility expiry the poison job comes back, attempt 2.
      deps.queue.expireInFlight();
      expect(await deps.queue.size()).toBe(1);
      const [back] = await deps.queue.receive(10);
      expect(back!.job.kind).toBe("media.purge");
      expect(back!.job.payload).toEqual({ mediaAssetId: "not-a-uuid" });
      expect(back!.job.attempt).toBe(2);
      evidence("S4", {
        workerFailures: failures,
        logLine: thrown,
        redeliveredAttempt: back!.job.attempt,
      });
    });

    it("S4b: malformed payload matrix — every variant is either a typed exception or an honest 'not found'", async () => {
      const rng = seededRandom(0x5eed_0004);
      const huge = Array.from({ length: 64 * 1024 }, () =>
        String.fromCharCode(0x61 + Math.floor(rng() * 26)),
      ).join("");
      const variants: Array<{ label: string; payload: unknown }> = [
        { label: "unicode", payload: { mediaAssetId: "🥒-sensei-\u0000" } },
        { label: "huge-64KiB", payload: { mediaAssetId: huge } },
        { label: "uuid-with-newline", payload: { mediaAssetId: `${randomUUID()}\n` } },
        { label: "array-payload", payload: [randomUUID()] },
        { label: "string-payload", payload: "not-an-object" },
        { label: "numeric-id", payload: { mediaAssetId: 12345 } },
        { label: "object-id", payload: { mediaAssetId: { toString: () => "x" } } },
        { label: "empty-object", payload: {} },
        { label: "null-id", payload: { mediaAssetId: null } },
        { label: "null-payload", payload: null },
      ];
      const fingerprint = async (): Promise<string> =>
        (
          await pool.query(
            "SELECT coalesce(md5(string_agg(id::text || status || coalesce(object_key, '') || coalesce(deleted_at::text, ''), ',' ORDER BY id)), '') AS fp FROM media_asset",
          )
        ).rows[0].fp as string;
      const before = await fingerprint();
      const results: Array<Record<string, unknown>> = [];
      for (const kind of ["media.purge", "media.process"] as const) {
        for (const variant of variants) {
          const deps = makeDeps();
          await deps.queue.enqueue(kind, variant.payload);
          const started = Date.now();
          const result = await runOnce(deps);
          const failures = deps.tracked.filter((e) => e.name === "worker_failure") as Array<{
            failureKind: string;
          }>;
          deps.queue.expireInFlight();
          const remaining = await deps.queue.size();
          const log = deps.logs.find((l) => l.startsWith(`${kind}: `)) ?? "";
          results.push({
            kind,
            label: variant.label,
            acked: result.jobs === 1,
            remaining,
            failureKind: failures[0]?.failureKind ?? null,
            logChars: log.length,
            ms: Date.now() - started,
          });
          // Invariant A: a job is either acked (handled) or left on the queue — never both, never neither.
          expect(result.jobs + remaining).toBe(1);
          // Invariant B: an exception is always reported as handler_exception, never swallowed.
          if (remaining === 1) expect(failures).toHaveLength(1);
          else expect(failures).toHaveLength(0);
        }
      }
      // Whatever happened, no media_asset row was touched.
      expect(await fingerprint()).toBe(before);
      evidence("S4b-matrix", { seed: "0x5eed0004", results });
    });

    // ───────────────────────────────────────────────────────────── S5 ──
    it("S5: grant → select → withdraw → hard-DELETE media_asset (FK SET NULL) → verify excludes, ledger = withdrawn", async () => {
      const uid = await createUser(`auth0|attack-s5-${randomUUID()}`);
      await appendConsent(uid, "granted");
      const assetKey = `media/${uid}/clip-${randomUUID()}`;
      const assetId = await insertAsset({ ownerId: uid, objectKey: assetKey, status: "ready" });
      const item = await pool.query(
        `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'model-training-v1') RETURNING id`,
        [uid, assetId],
      );
      const itemId = item.rows[0].id as string;

      const selected = (await selectTrainingEligibleItems(pool)).filter((i) => i.id === itemId);
      expect(selected).toHaveLength(1);
      expect(await recordTrainingEligibility(pool, selected)).toBe(1);
      expect(await isDatasetItemTrainingEligible(pool, itemId)).toBe(true);

      await appendConsent(uid, "withdrawn");
      // FK on ml_dataset_item.media_asset_id is SET NULL in this schema.
      const fk = await pool.query(
        `SELECT confdeltype FROM pg_constraint
       WHERE conname = 'ml_dataset_item_media_asset_id_fkey'
         AND conrelid = ($1 || '.ml_dataset_item')::regclass`,
        [schemaName],
      );
      expect(fk.rows[0].confdeltype).toBe("n");
      const hardDeleted = await pool.query("DELETE FROM media_asset WHERE id = $1", [assetId]);
      expect(hardDeleted.rowCount).toBe(1);
      const itemAfter = await pool.query(
        "SELECT media_asset_id, removed_at FROM ml_dataset_item WHERE id = $1",
        [itemId],
      );
      expect(itemAfter.rows[0].media_asset_id).toBeNull();

      // Fresh-connection re-verification drops the item.
      const verified = await verifyTrainingEligibility(pool, selected);
      expect(verified).toHaveLength(0);
      expect(await isDatasetItemTrainingEligible(pool, itemId)).toBe(false);
      const ledger = (await latestEligibilityEntries(pool, [itemId])).get(itemId);
      expect(ledger).toBeDefined();
      expect(ledger!.state).toBe("withdrawn"); // DB trigger appended it
      expect(ledger!.reason).toBe("consent.model_training.withdrawn");
      const history = await pool.query(
        "SELECT state FROM training_eligibility_ledger WHERE dataset_item_id = $1 ORDER BY seq",
        [itemId],
      );
      expect(history.rows.map((r) => r.state)).toEqual(["eligible", "withdrawn"]);

      // Twist: the hard delete left the item in place with removed_at NULL and
      // no media reference. On a RE-GRANT the selector returns it again even
      // though no media exists for it (documented in the report).
      await appendConsent(uid, "granted");
      const reselected = (await selectTrainingEligibleItems(pool)).filter((i) => i.id === itemId);
      evidence("S5", {
        ledgerHistory: history.rows.map((r) => r.state),
        itemRemovedAt: itemAfter.rows[0].removed_at,
        itemMediaAssetIdAfterHardDelete: itemAfter.rows[0].media_asset_id,
        reselectedAfterRegrantWithNoMedia: reselected.length,
      });
      expect(reselected).toHaveLength(1);
      // isDatasetItemTrainingEligible still fails closed (latest ledger entry is 'withdrawn').
      expect(await isDatasetItemTrainingEligible(pool, itemId)).toBe(false);
    });

    // ───────────────────────────────────────────────────────────── S6 ──
    it("S6: hard-DELETE media_asset while the transcoder promise is pending → UPDATE affects 0 rows, derived artifacts removed", async () => {
      const uid = await createUser(`auth0|attack-s6-${randomUUID()}`);
      const key = `media/${uid}/race-${randomUUID()}`;
      const id = await insertAsset({ ownerId: uid, objectKey: key, status: "processing" });
      let deleteRowCount = -1;
      let releaseTranscode: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        releaseTranscode = resolve;
      });
      const deps = makeDeps({
        transcoder: async ({ objectKey }) => {
          await gate; // stays pending until the row is gone
          const normalizedKey = `${objectKey}/normalized.mp4`;
          const thumbnailKey = `${objectKey}/thumb.jpg`;
          return { normalizedKey, thumbnailKey };
        },
      });
      deps.store.keys.add(key);
      const inFlight = handleJob(deps, {
        id: "j-s6",
        kind: "media.process",
        payload: { mediaAssetId: id },
        attempt: 1,
      });
      // Let handleJob reach the transcoder await, then hard-delete the row.
      await new Promise((r) => setTimeout(r, 50));
      const del = await pool.query("DELETE FROM media_asset WHERE id = $1", [id]);
      deleteRowCount = del.rowCount ?? -1;
      expect(deleteRowCount).toBe(1);
      // Simulate the transcoder finishing and writing derived objects.
      deps.store.keys.add(`${key}/normalized.mp4`);
      deps.store.keys.add(`${key}/thumb.jpg`);
      releaseTranscode!();
      const outcome = await inFlight;
      expect(outcome.handled).toBe(true);
      expect(outcome.note).toMatch(/deleted mid-transcode; derived artifacts removed/);
      expect(deps.store.deletedKeys).toEqual([`${key}/normalized.mp4`, `${key}/thumb.jpg`]);
      expect(deps.store.keys.has(`${key}/normalized.mp4`)).toBe(false);
      expect(deps.store.keys.has(`${key}/thumb.jpg`)).toBe(false);
      // No resurrection: the row is still gone.
      expect((await pool.query("SELECT 1 FROM media_asset WHERE id = $1", [id])).rowCount).toBe(0);
      // Master object: nobody owns it any more; sweep cannot see it (documented).
      const swept = await sweepDeletedMedia(deps);
      evidence("S6", {
        note: outcome.note,
        derivedDeleted: deps.store.deletedKeys,
        masterStillInStore: deps.store.keys.has(key),
        sweptAfterHardDelete: swept,
      });
      expect(deps.store.keys.has(key)).toBe(true);
    });

    it("S6b: rapid repeat — 25 pending transcodes, rows hard-deleted mid-flight in seeded order, zero derived leaks", async () => {
      const uid = await createUser(`auth0|attack-s6b-${randomUUID()}`);
      const rng = seededRandom(0x5eed_0006);
      const n = 25;
      const ids: string[] = [];
      const keys: string[] = [];
      for (let i = 0; i < n; i++) {
        const key = `media/${uid}/burst-${i}-${randomUUID()}`;
        keys.push(key);
        ids.push(await insertAsset({ ownerId: uid, objectKey: key, status: "processing" }));
      }
      const gates: Array<() => void> = [];
      const deps = makeDeps({
        transcoder: async ({ objectKey }) => {
          await new Promise<void>((resolve) => gates.push(resolve));
          deps.store.keys.add(`${objectKey}/normalized.mp4`);
          deps.store.keys.add(`${objectKey}/thumb.jpg`);
          return {
            normalizedKey: `${objectKey}/normalized.mp4`,
            thumbnailKey: `${objectKey}/thumb.jpg`,
          };
        },
      });
      for (const key of keys) deps.store.keys.add(key);
      const jobs = ids.map((id, i) =>
        handleJob(deps, {
          id: `j-${i}`,
          kind: "media.process",
          payload: { mediaAssetId: id },
          attempt: 1,
        }),
      );
      // Wait until every job is parked on its gate.
      while (gates.length < n) await new Promise((r) => setTimeout(r, 10));
      // Hard-delete a seeded subset while they are pending.
      const deleted = new Set<number>();
      for (let i = 0; i < n; i++) if (rng() < 0.5) deleted.add(i);
      await Promise.all(
        [...deleted].map((i) => pool.query("DELETE FROM media_asset WHERE id = $1", [ids[i]])),
      );
      // Release in seeded shuffled order.
      const order = [...Array(n).keys()].sort(() => rng() - 0.5);
      for (const i of order) gates[i]!();
      const outcomes = await Promise.all(jobs);
      let survivors = 0;
      for (let i = 0; i < n; i++) {
        const key = keys[i]!;
        const derivedPresent =
          deps.store.keys.has(`${key}/normalized.mp4`) || deps.store.keys.has(`${key}/thumb.jpg`);
        if (deleted.has(i)) {
          expect(outcomes[i]!.note).toMatch(/deleted mid-transcode/);
          expect(derivedPresent).toBe(false);
        } else {
          expect(outcomes[i]!.note).toMatch(/^normalized=/);
          expect(derivedPresent).toBe(true);
          survivors++;
        }
      }
      const ready = await pool.query(
        "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 AND status = 'ready'",
        [uid],
      );
      expect(ready.rows[0].n).toBe(survivors);
      evidence("S6b", { seed: "0x5eed0006", n, deletedMidFlight: deleted.size, survivors, order });
    });

    // ───────────────────────────────────────────────────────────── S7 ──
    it("S7: 500 expired share_video rows → 500 audit inserts + 500 enqueues; enforceMediaRetention and runOnce stay within WORKER_INTERVAL_MS", async () => {
      const uid = await createUser(`auth0|attack-s7-${randomUUID()}`);
      const n = 500;
      const oldCreated = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(
          await insertAsset({
            ownerId: uid,
            objectKey: `media/${uid}/share-${i}`,
            status: "ready",
            kind: "share_video",
            createdAt: oldCreated,
          }),
        );
      }
      // Control: a fresh share_video that must NOT expire.
      const fresh = await insertAsset({
        ownerId: uid,
        objectKey: `media/${uid}/share-fresh`,
        status: "ready",
        kind: "share_video",
      });
      const deps = makeDeps();
      for (let i = 0; i < n; i++) deps.store.keys.add(`media/${uid}/share-${i}`);
      const auditBefore = (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_log WHERE action = 'media.retention_expired'",
        )
      ).rows[0].n as number;

      const t0 = performance.now();
      const expired = await enforceMediaRetention(deps);
      const enforceMs = performance.now() - t0;
      expect(expired).toBe(n);
      const auditAfter = (
        await pool.query(
          "SELECT count(*)::int AS n, count(DISTINCT target_id)::int AS distinct_targets FROM audit_log WHERE action = 'media.retention_expired'",
        )
      ).rows[0] as { n: number; distinct_targets: number };
      expect(auditAfter.n - auditBefore).toBe(n);
      expect(auditAfter.distinct_targets).toBeGreaterThanOrEqual(n);
      expect(await deps.queue.size()).toBe(n);
      // Every expired id got exactly one purge job; the fresh one none.
      const queued = new Set<string>();
      for (let i = 0; i < n; i++) {
        const batch = await deps.queue.receive(10);
        for (const { job } of batch)
          queued.add((job.payload as { mediaAssetId: string }).mediaAssetId);
        if (batch.length === 0) break;
      }
      expect(queued.size).toBe(n);
      expect(queued.has(fresh)).toBe(false);
      deps.queue.expireInFlight();
      const freshRow = await pool.query("SELECT deleted_at FROM media_asset WHERE id = $1", [
        fresh,
      ]);
      expect(freshRow.rows[0].deleted_at).toBeNull();
      expect(enforceMs).toBeLessThan(WORKER_INTERVAL_MS);

      // Idempotent: a second pass finds nothing (no duplicate audits/enqueues).
      expect(await enforceMediaRetention(deps)).toBe(0);
      expect(await deps.queue.size()).toBe(n);

      // A full worker cycle with the 500 purge jobs waiting: 10 purges + 50 swept per cycle.
      const t1 = performance.now();
      const cycle = await runOnce(deps);
      const runOnceMs = performance.now() - t1;
      expect(cycle.jobs).toBe(10);
      expect(cycle.swept).toBe(50);
      expect(cycle.expired).toBe(0);
      expect(runOnceMs).toBeLessThan(WORKER_INTERVAL_MS);
      // How many cycles to drain the backlog of 500 objects at 60/cycle?
      let cycles = 1;
      const t2 = performance.now();
      while (true) {
        const remaining = await pool.query(
          "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 AND deleted_at IS NOT NULL AND object_key IS NOT NULL",
          [uid],
        );
        if ((remaining.rows[0].n as number) === 0) break;
        await runOnce(deps);
        cycles++;
        expect(cycles).toBeLessThan(30);
      }
      const drainMs = performance.now() - t2;
      expect(deps.store.keys.size).toBe(0);
      evidence("S7", {
        rows: n,
        enforceMs: Number(enforceMs.toFixed(1)),
        auditInserts: auditAfter.n - auditBefore,
        enqueues: queued.size,
        runOnceMs: Number(runOnceMs.toFixed(1)),
        workerIntervalMs: WORKER_INTERVAL_MS,
        cyclesToDrainObjects: cycles,
        drainMs: Number(drainMs.toFixed(1)),
        perCycleBudget: "10 purge jobs + 50 swept rows",
      });
    });

    it("S7b: enqueue failures do not abort retention — audit rows still land for every expired asset", async () => {
      const uid = await createUser(`auth0|attack-s7b-${randomUUID()}`);
      const n = 40;
      const oldCreated = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      for (let i = 0; i < n; i++) {
        await insertAsset({
          ownerId: uid,
          objectKey: `media/${uid}/s7b-${i}`,
          status: "ready",
          kind: "share_video",
          createdAt: oldCreated,
        });
      }
      let enqueueCalls = 0;
      const rng = seededRandom(0x5eed_0007);
      const flaky = new InMemoryJobQueue();
      const realEnqueue = flaky.enqueue.bind(flaky);
      flaky.enqueue = async (kind, payload) => {
        enqueueCalls++;
        if (rng() < 0.5) throw new Error("SQS unreachable (simulated)");
        return realEnqueue(kind, payload);
      };
      const deps = makeDeps({ queue: flaky });
      const expired = await enforceMediaRetention(deps);
      expect(expired).toBe(n);
      expect(enqueueCalls).toBe(n);
      const audits = await pool.query(
        `SELECT count(*)::int AS n FROM audit_log a JOIN media_asset m ON m.id::text = a.target_id
       WHERE a.action = 'media.retention_expired' AND m.owner_user_id = $1`,
        [uid],
      );
      expect(audits.rows[0].n).toBe(n);
      const dispatchFailures = deps.logs.filter((l) =>
        l.includes("media.purge dispatch for expired asset"),
      ).length;
      expect(dispatchFailures + (await flaky.size())).toBe(n);
      // The sweep purges what the queue lost.
      const swept = await sweepDeletedMedia(deps);
      expect(swept).toBe(n);
      evidence("S7b", { seed: "0x5eed0007", n, enqueueCalls, dispatchFailures, swept });
    });

    // ───────────────────────────────────────────────────────────── extras ──
    it("X1: a user_setting.local_video_retention_days out of range makes enforceMediaRetention throw → the whole runOnce cycle fails", async () => {
      const uid = await createUser(`auth0|attack-x1-${randomUUID()}`);
      await insertAsset({ ownerId: uid, objectKey: `media/${uid}/x1`, status: "ready" });
      // No CHECK constraint bounds the column (0001_extensions_identity.sql).
      await pool.query(
        "INSERT INTO user_setting (user_id, local_video_retention_days) VALUES ($1, 2147483647)",
        [uid],
      );
      const deps = makeDeps();
      let error: unknown = null;
      try {
        await runOnce(deps);
      } catch (e) {
        error = e;
      }
      evidence("X1", { error: String(error) });
      await pool.query("DELETE FROM user_setting WHERE user_id = $1", [uid]);
      // Documented failure mode (see report): one row poisons every cycle.
      expect(String(error)).toMatch(/interval|out of range|integer/);
    });

    it("X2: two workers processing the same deletion_task concurrently stay idempotent (no throw, user deleted once)", async () => {
      const uid = await createUser(`auth0|attack-x2-${randomUUID()}`);
      await pool.query("UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE id = $1", [
        uid,
      ]);
      for (let i = 0; i < 3; i++) {
        await insertAsset({
          ownerId: uid,
          objectKey: `media/${uid}/x2-${i}`,
          status: "deleted",
          deleted: true,
        });
      }
      const store = new FakeStore();
      for (let i = 0; i < 3; i++) store.keys.add(`media/${uid}/x2-${i}`);
      const a = makeDeps({ objectStore: store });
      const b = makeDeps({ objectStore: store });
      for (const kind of [
        "media_purge",
        "ml_dataset_review",
        "social_cleanup",
        "final_hard_delete",
      ]) {
        await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2)", [uid, kind]);
      }
      const [pa, pb] = await Promise.all([processDeletionTasks(a), processDeletionTasks(b)]);
      // Second pass in case the race left final_hard_delete requeued.
      const pc = await processDeletionTasks(a);
      expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [uid])).rowCount).toBe(0);
      const statuses = await pool.query(
        "SELECT kind, status FROM deletion_task WHERE user_id = $1 ORDER BY kind",
        [uid],
      );
      for (const row of statuses.rows as Array<{ status: string }>) expect(row.status).toBe("done");
      expect(store.keys.size).toBe(0);
      expect(a.logs.concat(b.logs).filter((l) => l.includes("failed"))).toEqual([]);
      evidence("X2", {
        processedA: pa,
        processedB: pb,
        processedC: pc,
        deletedKeys: store.deletedKeys.length,
      });
    });
  },
);
