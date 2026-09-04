import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue, SqsJobQueue } from "@pickle/queue";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  processDeletionTasks,
  runOnce,
  type WorkerDeps,
} from "../src/worker.js";
import {
  generateCorpus,
  hasFfmpeg,
  type CorpusManifest,
  type GeneratedCase,
} from "../../../packages/capture-envelope/test/xcMatrixMedia2/corpus.js";
import {
  createFfmpegTranscoder,
  FakeByteStore,
  TranscodeError,
  type FfmpegTranscoder,
} from "./xcMatrixMedia2/ffmpegTranscoder.js";

/**
 * xc-matrix-media-2 — media worker under adversarial media, with a REAL
 * ffmpeg transcoder (services/media-worker/src/main.ts ships `transcoder:
 * null`, so this is the only place the transcode branch meets real bytes).
 *
 * Real PostgreSQL (isolated schema), in-memory byte store, in-memory queue,
 * plus — when ElasticMQ is reachable — a real SQS redrive policy mirroring
 * infra/terraform/modules/media/main.tf (maxReceiveCount = 5).
 *
 * Asserted:
 *  - corrupt/unsupported/audio-only input → asset 'failed' + job acked, never
 *    a thrown handler, never 'ready' (typed failure);
 *  - decodable input (any extension/container/audio state) → 'ready' with
 *    both derived objects under `${objectKey}/`;
 *  - transcoder temp dirs are gone after success, ffmpeg failure, timeout,
 *    and mid-transcode deletion;
 *  - re-processing the same asset is idempotent (same status, same key set);
 *  - poison jobs stay visible (in-memory) / dead-letter after 5 receives
 *    (ElasticMQ redrive); deletion tasks stop retrying at
 *    DELETION_TASK_MAX_ATTEMPTS.
 *
 * OBSERVED (documented with `OBSERVED:` tests, not silently accepted): the
 * worker has no timeout around `deps.transcoder(...)` and treats every
 * transcoder rejection — including a storage read outage — as a permanent
 * 'failed' (acked, no retry).
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const ffmpegOk = hasFfmpeg();
const enabled = Boolean(testUrl) && ffmpegOk;
const schemaName = `xc_media2_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const migrationsDir = join(repoRoot, "packages", "database", "migrations");
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir =
  process.env["XC_MEDIA2_OUT"] ?? join(repoRoot, "artifacts", "xc-matrix-media-2", runStamp);
const SQS_ENDPOINT = process.env["XC_MEDIA2_SQS_ENDPOINT"] ?? "http://localhost:9324";

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

interface WorkerRow {
  id: string;
  category: GeneratedCase["category"];
  expected: GeneratedCase["expected"];
  sha256: string;
  bytes: number;
  recipe: string;
  firstStatus: string;
  firstNote: string;
  secondStatus: string;
  secondNote: string;
  derivedKeys: string[];
  derivedKeysAfterReprocess: string[];
  leakedTempDirs: string[];
  transcoderInvocations: number;
  wallMsFirst: number;
  wallMsSecond: number;
  queueDepthAfter: number;
}

interface ScenarioRow {
  scenario: string;
  observed: Record<string, unknown>;
}

const rows: WorkerRow[] = [];
const scenarios: ScenarioRow[] = [];
const workerLog: string[] = [];

describe.skipIf(!enabled)(
  "xc-matrix-media-2: media worker with a real ffmpeg transcoder (isolated PostgreSQL schema)",
  () => {
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    let userId: string;
    let workDir: string;
    let manifest: CorpusManifest;

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
      await runMigrations(pool, migrationsDir);
      await seed(pool);
      const user = await pool.query(
        "INSERT INTO app_user (auth_subject) VALUES ('auth0|xc-media2-worker') RETURNING id",
      );
      userId = user.rows[0].id as string;
      workDir = mkdtempSync(join(tmpdir(), "xc-media2-worker-"));
      mkdirSync(outDir, { recursive: true });
      manifest = generateCorpus(join(workDir, "corpus"));
      writeFileSync(join(outDir, "worker-corpus-manifest.json"), JSON.stringify(manifest, null, 2));
    }, 300_000);

    afterAll(async () => {
      writeFileSync(
        join(outDir, "worker-matrix.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            node: process.version,
            ffmpeg: manifest?.ffmpegVersion ?? null,
            heap: process.memoryUsage(),
            rows,
            scenarios,
          },
          null,
          2,
        ),
      );
      writeFileSync(join(outDir, "worker.log"), workerLog.join("\n") + "\n");
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    function makeDeps(
      overrides: Partial<WorkerDeps> & {
        transcoderOpts?: {
          timeoutMs?: number;
          onBeforeFfmpeg?: (dir: string) => void | Promise<void>;
        };
      } = {},
    ): {
      deps: WorkerDeps;
      store: FakeByteStore;
      queue: InMemoryJobQueue;
      transcoder: FfmpegTranscoder;
    } {
      const store = new FakeByteStore();
      const queue = new InMemoryJobQueue();
      const { transcoderOpts, ...depOverrides } = overrides;
      const transcoder = createFfmpegTranscoder({
        store,
        tmpRoot: workDir,
        ...(transcoderOpts?.timeoutMs !== undefined ? { timeoutMs: transcoderOpts.timeoutMs } : {}),
        ...(transcoderOpts?.onBeforeFfmpeg
          ? { onBeforeFfmpeg: transcoderOpts.onBeforeFfmpeg }
          : {}),
      });
      const deps: WorkerDeps = {
        pool,
        queue,
        objectStore: store,
        transcoder: transcoder.transcode,
        log: (line) => workerLog.push(line),
        ...depOverrides,
      };
      return { deps, store, queue, transcoder };
    }

    async function insertAsset(
      store: FakeByteStore,
      c: GeneratedCase,
      status = "processing",
    ): Promise<{ id: string; objectKey: string }> {
      const id = randomUUID();
      const objectKey = `media/${userId}/${id}/master`;
      await store.putObject(objectKey, readFileSync(c.path));
      await pool.query(
        `INSERT INTO media_asset (id, owner_user_id, kind, bucket, object_key, status, content_type, size_bytes, sha256)
       VALUES ($1, $2, 'raw_video', 'b', $3, $4, $5, $6, $7)`,
        [id, userId, objectKey, status, c.claimedContentType, c.bytes, c.sha256],
      );
      return { id, objectKey };
    }

    async function statusOf(id: string): Promise<string> {
      const r = await pool.query("SELECT status FROM media_asset WHERE id = $1", [id]);
      return (r.rows[0] as { status: string }).status;
    }

    it("matrix: every corpus case → typed outcome, temp dirs cleaned, idempotent re-process", async () => {
      for (const c of manifest.cases) {
        const { deps, store, queue, transcoder } = makeDeps();
        const { id, objectKey } = await insertAsset(store, c);
        const logStart = workerLog.length;

        await queue.enqueue("media.process", { mediaAssetId: id });
        const t0 = performance.now();
        await runOnce(deps);
        const wallMsFirst = performance.now() - t0;
        const firstStatus = await statusOf(id);
        const firstNote =
          workerLog.slice(logStart).find((l) => l.startsWith("media.process:")) ?? "";
        const derivedKeys = (await store.listObjects(`${objectKey}/`)).sort();
        const leaked1 = transcoder.leakedTempDirs();

        const logStart2 = workerLog.length;
        await queue.enqueue("media.process", { mediaAssetId: id });
        const t1 = performance.now();
        await runOnce(deps);
        const wallMsSecond = performance.now() - t1;
        const secondStatus = await statusOf(id);
        const secondNote =
          workerLog.slice(logStart2).find((l) => l.startsWith("media.process:")) ?? "";
        const derivedKeysAfterReprocess = (await store.listObjects(`${objectKey}/`)).sort();

        rows.push({
          id: c.id,
          category: c.category,
          expected: c.expected,
          sha256: c.sha256,
          bytes: c.bytes,
          recipe: c.recipe,
          firstStatus,
          firstNote,
          secondStatus,
          secondNote,
          derivedKeys,
          derivedKeysAfterReprocess,
          leakedTempDirs: [...leaked1, ...transcoder.leakedTempDirs()],
          transcoderInvocations: transcoder.stats.invocations,
          wallMsFirst,
          wallMsSecond,
          queueDepthAfter: await queue.size(),
        });
      }
      expect(rows.length).toBe(manifest.cases.length);
    }, 900_000);

    it("no handler ever threw and every media.process job was acked (typed outcome, never a poison loop)", () => {
      for (const r of rows) {
        expect(r.firstNote, r.id).not.toContain("handler threw");
        expect(r.secondNote, r.id).not.toContain("handler threw");
        expect(r.queueDepthAfter, r.id).toBe(0);
        expect(["ready", "failed"], r.id).toContain(r.firstStatus);
      }
    });

    it("corrupt / truncated-moov / audio-only / text / wav / raw masters → 'failed' with a typed transcode note and no derived objects", () => {
      const rejects = rows.filter((r) => r.expected === "typed_reject");
      expect(rejects.length).toBeGreaterThanOrEqual(10);
      for (const r of rejects) {
        expect(r.firstStatus, r.id).toBe("failed");
        expect(r.firstNote, r.id).toMatch(
          /^media\.process: transcode failed \(asset marked failed\): TranscodeError: ffmpeg exit=/,
        );
        expect(r.derivedKeys, r.id).toEqual([]);
      }
    });

    it("decodable masters (wrong extension, mkv/webm/avi/prores/hevc/mpeg4, no audio, silent, rotated, odd dims) → 'ready' with both derived objects under the master prefix", () => {
      const ok = rows.filter((r) => r.expected === "decodable");
      expect(ok.length).toBeGreaterThanOrEqual(20);
      for (const r of ok) {
        expect(r.firstStatus, `${r.id}: ${r.firstNote}`).toBe("ready");
        expect(r.derivedKeys.length, r.id).toBe(2);
        expect(
          r.derivedKeys.every((k) => k.endsWith("/normalized.mp4") || k.endsWith("/thumb.jpg")),
          r.id,
        ).toBe(true);
      }
    });

    it("degenerate masters (stills, 1 frame, extreme aspect, 16x16, truncated tails) never crash the worker: 'ready' or 'failed', never stuck 'processing'", () => {
      for (const r of rows.filter((x) => x.expected === "degenerate")) {
        expect(["ready", "failed"], `${r.id}: ${r.firstNote}`).toContain(r.firstStatus);
      }
    });

    it("transcoder temp dirs are removed after every case (success and failure paths)", () => {
      for (const r of rows) expect(r.leakedTempDirs, r.id).toEqual([]);
    });

    it("re-processing is idempotent: same status, same derived key set, transcoder actually re-ran (no hidden cache)", () => {
      for (const r of rows) {
        expect(r.secondStatus, r.id).toBe(r.firstStatus);
        expect(r.derivedKeysAfterReprocess, r.id).toEqual(r.derivedKeys);
        expect(r.transcoderInvocations, r.id).toBe(2);
      }
    });

    it("every case transcodes (or fails) inside 60 s wall clock", () => {
      for (const r of rows) {
        expect(r.wallMsFirst, r.id).toBeLessThan(60_000);
        expect(r.wallMsSecond, r.id).toBeLessThan(60_000);
      }
    });

    it("asset deleted mid-transcode: master + derived objects removed, asset stays deleted, temp dir cleaned", async () => {
      let assetId = "";
      const { deps, store, queue, transcoder } = makeDeps({
        transcoderOpts: {
          onBeforeFfmpeg: async () => {
            await pool.query(
              "UPDATE media_asset SET status='deleted', deleted_at=now() WHERE id=$1",
              [assetId],
            );
          },
        },
      });
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const { id, objectKey } = await insertAsset(store, base);
      assetId = id;
      await queue.enqueue("media.process", { mediaAssetId: id });
      await runOnce(deps);
      const derived = await store.listObjects(`${objectKey}/`);
      scenarios.push({
        scenario: "deleted_mid_transcode",
        observed: {
          status: await statusOf(id),
          derived,
          deletedKeys: store.deletedKeys,
          leaked: transcoder.leakedTempDirs(),
        },
      });
      expect(await statusOf(id)).toBe("deleted");
      expect(derived).toEqual([]);
      expect(store.deletedKeys.sort()).toEqual([
        objectKey,
        `${objectKey}/normalized.mp4`,
        `${objectKey}/thumb.jpg`,
      ]);
      expect(store.bytes.size).toBe(0);
      expect(transcoder.leakedTempDirs()).toEqual([]);
    }, 120_000);

    it("cancellation (transcoder aborted before ffmpeg) leaves no temp dir and a typed 'failed'", async () => {
      const { deps, store, queue, transcoder } = makeDeps({
        transcoderOpts: {
          onBeforeFfmpeg: () => {
            throw new TranscodeError("ffmpeg_failed", "synthetic cancellation");
          },
        },
      });
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const { id, objectKey } = await insertAsset(store, base);
      await queue.enqueue("media.process", { mediaAssetId: id });
      await runOnce(deps);
      scenarios.push({
        scenario: "cancelled_before_ffmpeg",
        observed: {
          status: await statusOf(id),
          leaked: transcoder.leakedTempDirs(),
          derived: await store.listObjects(`${objectKey}/`),
        },
      });
      expect(await statusOf(id)).toBe("failed");
      expect(transcoder.leakedTempDirs()).toEqual([]);
      expect(await store.listObjects(`${objectKey}/`)).toEqual([]);
      expect(await queue.size()).toBe(0);
    }, 60_000);

    it("ffmpeg wall-clock timeout (SIGKILL) → typed 'failed', temp dir cleaned, no partial derived objects", async () => {
      const { deps, store, queue, transcoder } = makeDeps({ transcoderOpts: { timeoutMs: 40 } });
      const big = manifest.cases.find((c) => c.id === "base_1080x1920_portrait")!;
      const { id, objectKey } = await insertAsset(store, big);
      await queue.enqueue("media.process", { mediaAssetId: id });
      const logStart = workerLog.length;
      await runOnce(deps);
      const note = workerLog.slice(logStart).find((l) => l.startsWith("media.process:")) ?? "";
      scenarios.push({
        scenario: "ffmpeg_timeout_40ms",
        observed: { status: await statusOf(id), note, leaked: transcoder.leakedTempDirs() },
      });
      expect(await statusOf(id)).toBe("failed");
      expect(note).toContain("ffmpeg exceeded 40 ms");
      expect(transcoder.leakedTempDirs()).toEqual([]);
      expect(await store.listObjects(`${objectKey}/`)).toEqual([]);
    }, 60_000);

    it("OBSERVED: a storage READ outage during transcode is recorded as permanent 'failed' and the job is acked (no retry path distinguishes transient errors)", async () => {
      const { deps, store, queue } = makeDeps();
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const { id } = await insertAsset(store, base);
      store.failReads = new Error("synthetic S3 503 SlowDown");
      await queue.enqueue("media.process", { mediaAssetId: id });
      const logStart = workerLog.length;
      await runOnce(deps);
      const note = workerLog.slice(logStart).find((l) => l.startsWith("media.process:")) ?? "";
      scenarios.push({
        scenario: "storage_read_outage",
        observed: { status: await statusOf(id), note, queueDepth: await queue.size() },
      });
      // Documents current behaviour (worker.ts media.process catch-all).
      expect(await statusOf(id)).toBe("failed");
      expect(note).toContain("transcode failed (asset marked failed)");
      expect(note).toContain("synthetic S3 503 SlowDown");
      expect(await queue.size()).toBe(0);
    }, 60_000);

    it("OBSERVED (production wiring, src/main.ts transcoder: null): every corrupt/junk/text master is promoted to 'ready' without any inspection", async () => {
      const { deps, store, queue } = makeDeps({ transcoder: null });
      const promoted: Array<{ id: string; status: string; note: string }> = [];
      for (const c of manifest.cases.filter((x) => x.expected === "typed_reject")) {
        const { id } = await insertAsset(store, c);
        await queue.enqueue("media.process", { mediaAssetId: id });
        const logStart = workerLog.length;
        await runOnce(deps);
        promoted.push({
          id: c.id,
          status: await statusOf(id),
          note: workerLog.slice(logStart).find((l) => l.startsWith("media.process:")) ?? "",
        });
      }
      scenarios.push({ scenario: "null_transcoder_production_wiring", observed: { promoted } });
      expect(promoted.length).toBeGreaterThanOrEqual(10);
      for (const p of promoted) {
        expect(p.status, p.id).toBe("ready");
        expect(p.note, p.id).toContain("no transcoder configured");
      }
    }, 60_000);

    it("OBSERVED: the worker has no timeout around deps.transcoder — a hung transcoder hangs runOnce indefinitely", async () => {
      let release: (() => void) | null = null;
      const hung = new Promise<{ normalizedKey: string; thumbnailKey: string }>((resolve) => {
        release = () => resolve({ normalizedKey: "x/normalized.mp4", thumbnailKey: "x/thumb.jpg" });
      });
      const { deps, store, queue } = makeDeps({ transcoder: () => hung });
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const { id } = await insertAsset(store, base);
      await queue.enqueue("media.process", { mediaAssetId: id });
      const run = runOnce(deps).then(() => "finished" as const);
      const timer = new Promise<"still_running">((r) => setTimeout(() => r("still_running"), 3000));
      const result = await Promise.race([run, timer]);
      scenarios.push({
        scenario: "hung_transcoder_3s",
        observed: { result, statusDuring: await statusOf(id) },
      });
      expect(result).toBe("still_running");
      expect(await statusOf(id)).toBe("processing");
      release!();
      await run;
    }, 30_000);

    it("poison jobs on the in-memory queue stay visible: unknown asset, empty payload, malformed kind are redelivered every cycle with an increasing attempt counter, and the worker itself imposes no cap", async () => {
      const { deps, queue } = makeDeps();
      await queue.enqueue("media.process", { mediaAssetId: randomUUID() });
      await queue.enqueue("media.process", {});
      await queue.enqueue("__malformed__", "{not json");
      const cycles = 8;
      for (let i = 0; i < cycles; i++) {
        const out = await runOnce(deps);
        expect(out.jobs, `cycle ${i}`).toBe(0);
        queue.expireInFlight();
      }
      const finalDepth = await queue.size();
      const received = await queue.receive(10);
      scenarios.push({
        scenario: "poison_in_memory",
        observed: {
          cycles,
          finalDepth,
          attempts: received.map((r) => ({ kind: r.job.kind, attempt: r.job.attempt })),
        },
      });
      expect(finalDepth).toBe(3);
      for (const r of received) expect(r.job.attempt).toBe(cycles + 1);
    }, 60_000);

    it("deletion tasks are retried at most DELETION_TASK_MAX_ATTEMPTS times when the object store keeps failing", async () => {
      const { deps, store } = makeDeps();
      const victim = await pool.query(
        "INSERT INTO app_user (auth_subject) VALUES ('auth0|xc-media2-deletion') RETURNING id",
      );
      const victimId = (victim.rows[0] as { id: string }).id;
      const objectKey = `media/${victimId}/${randomUUID()}/master`;
      await store.putObject(objectKey, Buffer.from("x"));
      await pool.query(
        "INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status) VALUES ($1,'raw_video','b',$2,'ready')",
        [victimId, objectKey],
      );
      const task = await pool.query(
        "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge') RETURNING id",
        [victimId],
      );
      const taskId = (task.rows[0] as { id: string }).id;
      store.deleteObject = async () => {
        throw new Error("synthetic storage outage");
      };
      const perCycle: Array<{ status: string; attempts: number }> = [];
      for (let i = 0; i < DELETION_TASK_MAX_ATTEMPTS + 4; i++) {
        await processDeletionTasks(deps);
        const r = await pool.query("SELECT status, attempts FROM deletion_task WHERE id = $1", [
          taskId,
        ]);
        perCycle.push(r.rows[0] as { status: string; attempts: number });
      }
      scenarios.push({
        scenario: "deletion_task_bounded_retry",
        observed: { perCycle, cap: DELETION_TASK_MAX_ATTEMPTS },
      });
      expect(perCycle.at(-1)).toEqual({ status: "failed", attempts: DELETION_TASK_MAX_ATTEMPTS });
      expect(perCycle.filter((p) => p.attempts > DELETION_TASK_MAX_ATTEMPTS)).toEqual([]);
      // the asset was never falsely marked purged
      const asset = await pool.query(
        "SELECT object_key, status FROM media_asset WHERE owner_user_id = $1",
        [victimId],
      );
      expect(asset.rows[0]).toEqual({ object_key: objectKey, status: "ready" });
    }, 60_000);

    describe("real SQS redrive (ElasticMQ) — mirrors infra maxReceiveCount = 5", () => {
      const acct = `${SQS_ENDPOINT}/000000000000`;
      const qName = `xc-media2-${process.pid}-${Date.now()}`;
      const dlqName = `${qName}-dlq`;
      let reachable = false;

      async function sqsQuery(params: Record<string, string>): Promise<string> {
        const body = new URLSearchParams({ Version: "2012-11-05", ...params });
        const res = await fetch(`${SQS_ENDPOINT}/`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        const text = await res.text();
        if (!res.ok)
          throw new Error(`SQS ${params["Action"]} ${res.status}: ${text.slice(0, 300)}`);
        return text;
      }

      function attr(xml: string, name: string): string | null {
        const m = new RegExp(`<Name>${name}</Name>\\s*<Value>([^<]*)</Value>`).exec(xml);
        return m ? m[1]! : null;
      }

      beforeAll(async () => {
        try {
          await sqsQuery({ Action: "ListQueues" });
          reachable = true;
        } catch {
          reachable = false;
          return;
        }
        process.env["AWS_ACCESS_KEY_ID"] ??= "xc-media2";
        process.env["AWS_SECRET_ACCESS_KEY"] ??= "xc-media2";
        await sqsQuery({ Action: "CreateQueue", QueueName: dlqName });
        await sqsQuery({
          Action: "CreateQueue",
          QueueName: qName,
          "Attribute.1.Name": "VisibilityTimeout",
          "Attribute.1.Value": "1",
          "Attribute.2.Name": "RedrivePolicy",
          "Attribute.2.Value": JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:elasticmq:000000000000:${dlqName}`,
            maxReceiveCount: "5",
          }),
        });
      });

      afterAll(async () => {
        if (!reachable) return;
        for (const q of [qName, dlqName]) {
          await sqsQuery({ Action: "DeleteQueue", QueueUrl: `${acct}/${q}` }).catch(
            () => undefined,
          );
        }
      });

      it("poison media.process (unknown asset) and a non-JSON body dead-letter after exactly 5 receives; a valid job is acked", async () => {
        if (!reachable) {
          scenarios.push({
            scenario: "sqs_redrive",
            observed: { skipped: `ElasticMQ not reachable at ${SQS_ENDPOINT}` },
          });
          expect.fail(
            `ElasticMQ not reachable at ${SQS_ENDPOINT} — start it with: docker compose up -d elasticmq`,
          );
        }
        const queue = new SqsJobQueue({
          queueUrl: `${acct}/${qName}`,
          region: "elasticmq",
          endpoint: SQS_ENDPOINT,
        });
        const dlq = new SqsJobQueue({
          queueUrl: `${acct}/${dlqName}`,
          region: "elasticmq",
          endpoint: SQS_ENDPOINT,
        });
        const store = new FakeByteStore();
        const transcoder = createFfmpegTranscoder({ store, tmpRoot: workDir });
        const deps: WorkerDeps = {
          pool,
          queue,
          objectStore: store,
          transcoder: transcoder.transcode,
          log: (l) => workerLog.push(l),
        };

        const base = manifest.cases.find((c) => c.id === "video_only_no_audio")!;
        const { id: goodId } = await insertAsset(store, base);
        await queue.enqueue("media.process", { mediaAssetId: goodId });
        await queue.enqueue("media.process", { mediaAssetId: randomUUID() });
        await sqsQuery({
          Action: "SendMessage",
          QueueUrl: `${acct}/${qName}`,
          MessageBody: "{not json at all",
        });

        const timeline: Array<{
          cycle: number;
          acked: number;
          mainVisible: string | null;
          mainInFlight: string | null;
          dlqDepth: string | null;
        }> = [];
        for (let cycle = 1; cycle <= 9; cycle++) {
          const out = await runOnce(deps);
          const main = await sqsQuery({
            Action: "GetQueueAttributes",
            QueueUrl: `${acct}/${qName}`,
            "AttributeName.1": "All",
          });
          const dead = await sqsQuery({
            Action: "GetQueueAttributes",
            QueueUrl: `${acct}/${dlqName}`,
            "AttributeName.1": "All",
          });
          timeline.push({
            cycle,
            acked: out.jobs,
            mainVisible: attr(main, "ApproximateNumberOfMessages"),
            mainInFlight: attr(main, "ApproximateNumberOfMessagesNotVisible"),
            dlqDepth: attr(dead, "ApproximateNumberOfMessages"),
          });
          if (
            attr(dead, "ApproximateNumberOfMessages") === "2" &&
            attr(main, "ApproximateNumberOfMessages") === "0" &&
            attr(main, "ApproximateNumberOfMessagesNotVisible") === "0"
          )
            break;
          await new Promise((r) => setTimeout(r, 1200)); // let the 1 s visibility timeout expire
        }
        const deadLetters = await dlq.receive(10);
        scenarios.push({
          scenario: "sqs_redrive",
          observed: {
            timeline,
            deadLetters: deadLetters.map((d) => ({
              kind: d.job.kind,
              attempt: d.job.attempt,
              payload: d.job.payload,
            })),
            goodStatus: await statusOf(goodId),
          },
        });

        expect(await statusOf(goodId)).toBe("ready");
        expect(timeline[0]?.acked).toBe(1);
        expect(deadLetters.map((d) => d.job.kind).sort()).toEqual([
          "__malformed__",
          "media.process",
        ]);
        const last = timeline.at(-1)!;
        expect(last.dlqDepth).toBe("2");
        expect(last.mainVisible).toBe("0");
        expect(last.mainInFlight).toBe("0");
        // 5 receives on the main queue before redrive → it took ≥ 5 worker cycles
        expect(timeline.length).toBeGreaterThanOrEqual(5);
        expect(timeline.filter((t) => t.dlqDepth !== "0").length).toBeLessThanOrEqual(
          timeline.length - 4,
        );
        for (const d of deadLetters) await d.ack();
      }, 120_000);
    });
  },
);
