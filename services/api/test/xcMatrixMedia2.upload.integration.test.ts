import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "@pickle/media-worker/worker";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { sha256HexToBase64 } from "../src/modules/media/objectStore.js";
import { FakeObjectStore } from "./support/fakeObjectStore.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";
import {
  generateCorpus,
  hasFfmpeg,
  type CorpusManifest,
  type GeneratedCase,
} from "../../../packages/capture-envelope/test/xcMatrixMedia2/corpus.js";

/**
 * xc-matrix-media-2 — upload validation surface, driven by the SAME ffmpeg
 * corpus used against capture-envelope / first-party-intake / media-worker.
 *
 * Surface note (VERIFIED by grep, see summary): the shipping edge function
 * `supabase/functions/api` has NO media upload route — video never leaves the
 * device. The only upload-validation code in the repo is the legacy Fastify
 * `services/api/src/modules/media/routes.ts`; that is what runs here, against
 * a real PostgreSQL schema, a fake object store and an in-memory queue.
 *
 * Per corpus case the honest path (declare the real size/sha256/type, store
 * exactly that) is run, then four spoof axes on fresh assets:
 *   missing object · larger stored object · wrong stored content type ·
 *   checksum mismatch. Every rejection must be a typed 4xx, the asset must
 *   be `deleted` and a `media.purge` job queued. Declaration-level rejections
 *   (bad type / empty file / non-hex sha / >500 MiB) are typed 4xx with no
 *   row created.
 *
 * Then the accepted ('ready') assets are pushed through the media worker in
 * its PRODUCTION wiring (`transcoder: null`, src/main.ts) to show what a
 * junk master looks like downstream.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const enabled = Boolean(testUrl) && hasFfmpeg();
const secret = "xc-media2-upload-secret-0123456789";
const schemaName = `xc_media2_api_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const migrationsDir = join(repoRoot, "packages", "database", "migrations");
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir =
  process.env["XC_MEDIA2_OUT"] ?? join(repoRoot, "artifacts", "xc-matrix-media-2", runStamp);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

type Axis =
  "honest" | "missing_object" | "oversized_stored" | "wrong_stored_type" | "checksum_mismatch";

interface UploadRow {
  id: string;
  category: GeneratedCase["category"];
  expected: GeneratedCase["expected"];
  bytes: number;
  sha256: string;
  claimedContentType: string;
  axis: Axis;
  createStatus: number;
  createCode: string | null;
  completeStatus: number | null;
  completeCode: string | null;
  completeKind: string | null;
  dbStatus: string | null;
  deletedAt: boolean | null;
  purgeQueued: boolean | null;
  processQueued: boolean | null;
  playbackStatus: number | null;
}

interface ScenarioRow {
  scenario: string;
  observed: Record<string, unknown>;
}

const rows: UploadRow[] = [];
const scenarios: ScenarioRow[] = [];

describe.skipIf(!enabled)(
  "xc-matrix-media-2: upload validation matrix (services/api, isolated PostgreSQL schema)",
  () => {
    let app: FastifyInstance;
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    let queue: InMemoryJobQueue;
    let store: FakeObjectStore;
    let userToken: string;
    let userId: string;
    let workDir: string;
    let manifest: CorpusManifest;

    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      const scopedUrl = schemaUrl(testUrl!, schemaName);
      pool = new pg.Pool({ connectionString: scopedUrl });
      await runMigrations(pool, migrationsDir);
      await seed(pool);
      await publishTestScoringRelease(pool);

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
      // The default per-user budget for the media routes is 60/min
      // (plugins/rateLimitPlugin.ts EXPENSIVE_ROUTES); this matrix fires ~700
      // requests, so it is raised here exactly as other integration suites do.
      // The default budget itself is asserted in its own test below.
      app = buildApp(config, {
        queue,
        objectStore: store,
        rateLimit: {
          enabled: true,
          windowMs: 60_000,
          defaultLimit: 100_000,
          expensiveLimit: 100_000,
        },
      });

      const minter = new DevTokenVerifier("test", secret);
      userToken = await minter.mint(`xc-media2|${randomUUID()}`);
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

      workDir = mkdtempSync(join(tmpdir(), "xc-media2-upload-"));
      mkdirSync(outDir, { recursive: true });
      manifest = generateCorpus(join(workDir, "corpus"));
      writeFileSync(join(outDir, "upload-corpus-manifest.json"), JSON.stringify(manifest, null, 2));
    }, 300_000);

    afterAll(async () => {
      writeFileSync(
        join(outDir, "upload-matrix.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            node: process.version,
            heap: process.memoryUsage(),
            rows,
            scenarios,
          },
          null,
          2,
        ),
      );
      await app?.close();
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    async function drainQueue(): Promise<Array<{ kind: string; mediaAssetId: string }>> {
      const received = await queue.receive(1000);
      const out = received.map(({ job }) => ({
        kind: job.kind,
        mediaAssetId: (job.payload as { mediaAssetId: string }).mediaAssetId,
      }));
      for (const r of received) await r.ack();
      return out;
    }

    async function dbState(id: string): Promise<{ status: string; deletedAt: boolean } | null> {
      const r = await pool.query("SELECT status, deleted_at FROM media_asset WHERE id = $1", [id]);
      if (r.rowCount === 0) return null;
      const row = r.rows[0] as { status: string; deleted_at: Date | null };
      return { status: row.status, deletedAt: row.deleted_at !== null };
    }

    async function runAxis(c: GeneratedCase, axis: Axis): Promise<UploadRow> {
      const row: UploadRow = {
        id: c.id,
        category: c.category,
        expected: c.expected,
        bytes: c.bytes,
        sha256: c.sha256,
        claimedContentType: c.claimedContentType,
        axis,
        createStatus: 0,
        createCode: null,
        completeStatus: null,
        completeCode: null,
        completeKind: null,
        dbStatus: null,
        deletedAt: null,
        purgeQueued: null,
        processQueued: null,
        playbackStatus: null,
      };
      const create = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(userToken),
        payload: {
          kind: "raw_video",
          filename: c.fileName,
          bytes: c.bytes,
          contentType: c.claimedContentType,
          sha256: c.sha256,
        },
      });
      row.createStatus = create.statusCode;
      if (create.statusCode !== 200) {
        row.createCode = (create.json() as { error?: { code?: string } }).error?.code ?? null;
        return row;
      }
      const { mediaAssetId } = create.json() as { mediaAssetId: string };
      const keyRow = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
        mediaAssetId,
      ]);
      const objectKey = (keyRow.rows[0] as { object_key: string }).object_key;

      switch (axis) {
        case "honest":
          store.objects.set(objectKey, c.bytes);
          break;
        case "missing_object":
          break;
        case "oversized_stored":
          store.objects.set(objectKey, c.bytes + 1);
          break;
        case "wrong_stored_type":
          store.objects.set(objectKey, c.bytes);
          store.storedContentType.set(objectKey, "application/octet-stream");
          break;
        case "checksum_mismatch": {
          store.objects.set(objectKey, c.bytes);
          const other = createHash("sha256")
            .update(c.sha256 + ":tampered")
            .digest("hex");
          store.storedChecksum.set(objectKey, sha256HexToBase64(other));
          break;
        }
      }
      const complete = await app.inject({
        method: "POST",
        url: `/v1/media/${mediaAssetId}/complete`,
        headers: auth(userToken),
      });
      row.completeStatus = complete.statusCode;
      if (complete.statusCode !== 200) {
        const err = (complete.json() as { error?: { code?: string; kind?: string } }).error;
        row.completeCode = err?.code ?? null;
        row.completeKind = err?.kind ?? null;
      }
      const state = await dbState(mediaAssetId);
      row.dbStatus = state?.status ?? null;
      row.deletedAt = state?.deletedAt ?? null;
      const jobs = await drainQueue();
      row.purgeQueued = jobs.some(
        (j) => j.kind === "media.purge" && j.mediaAssetId === mediaAssetId,
      );
      row.processQueued = jobs.some(
        (j) => j.kind === "media.process" && j.mediaAssetId === mediaAssetId,
      );
      const playback = await app.inject({
        method: "GET",
        url: `/v1/media/${mediaAssetId}`,
        headers: auth(userToken),
      });
      row.playbackStatus = playback.statusCode;
      return row;
    }

    const AXES: Axis[] = [
      "honest",
      "missing_object",
      "oversized_stored",
      "wrong_stored_type",
      "checksum_mismatch",
    ];

    it("matrix: every corpus case × every axis yields a typed response (never 5xx)", async () => {
      for (const c of manifest.cases) for (const axis of AXES) rows.push(await runAxis(c, axis));
      expect(rows.length).toBe(manifest.cases.length * AXES.length);
      const fiveHundreds = rows.filter(
        (r) => r.createStatus >= 500 || (r.completeStatus ?? 0) >= 500,
      );
      expect(fiveHundreds.map((r) => `${r.id}/${r.axis}`)).toEqual([]);
    }, 300_000);

    it("default rate limit: the media routes share a 60/min per-user budget and the 61st request is a typed 429 with Retry-After", async () => {
      const limited = buildApp(
        {
          env: "test",
          port: 0,
          host: "127.0.0.1",
          appVersion: "0.1.0-test",
          databaseUrl: schemaUrl(testUrl!, schemaName),
          devAuthSecret: secret,
          oidcIssuer: undefined,
          oidcAudience: undefined,
          oidcJwksUrl: undefined,
          sqsQueueUrl: undefined,
          consentExportSigningKey: undefined,
          consentExportSigningKeyId: "consent-export-k1",
          appleIapConfigured: false,
          googlePlayConfigured: false,
        },
        { queue: new InMemoryJobQueue(), objectStore: new FakeObjectStore() },
      );
      try {
        const base = manifest.cases.find((c) => c.id === "junk_64k")!;
        const statuses: number[] = [];
        let retryAfter: string | undefined;
        for (let i = 0; i < 61; i++) {
          const res = await limited.inject({
            method: "POST",
            url: "/v1/media/uploads",
            headers: auth(userToken),
            payload: {
              kind: "raw_video",
              filename: base.fileName,
              bytes: base.bytes,
              contentType: base.claimedContentType,
              sha256: base.sha256,
            },
          });
          statuses.push(res.statusCode);
          if (res.statusCode === 429) retryAfter = res.headers["retry-after"] as string | undefined;
        }
        scenarios.push({
          scenario: "default_rate_limit",
          observed: {
            ok: statuses.filter((s) => s === 200).length,
            limited: statuses.filter((s) => s === 429).length,
            retryAfter,
          },
        });
        expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
        expect(statuses[60]).toBe(429);
        expect(retryAfter).toBeDefined();
      } finally {
        await limited.close();
      }
    }, 60_000);

    it("declaration: a zero-byte file is refused at create (typed 400) and never gets a row", () => {
      for (const r of rows.filter((x) => x.id === "empty_file")) {
        expect(r.createStatus, r.axis).toBe(400);
        expect(r.completeStatus, r.axis).toBeNull();
      }
    });

    it("honest uploads of every NON-empty corpus file are accepted as 'ready', media.process is queued and playback is presigned — no content inspection happens at this surface (OBSERVED)", () => {
      const honest = rows.filter((r) => r.axis === "honest" && r.id !== "empty_file");
      expect(honest.length).toBe(manifest.cases.length - 1);
      for (const r of honest) {
        expect(r.createStatus, r.id).toBe(200);
        expect(r.completeStatus, r.id).toBe(200);
        expect(r.dbStatus, r.id).toBe("ready");
        expect(r.processQueued, r.id).toBe(true);
        expect(r.purgeQueued, r.id).toBe(false);
        expect(r.playbackStatus, r.id).toBe(200);
      }
      const junkAccepted = honest.filter((r) => r.expected === "typed_reject").map((r) => r.id);
      scenarios.push({ scenario: "junk_accepted_as_ready", observed: { junkAccepted } });
      expect(junkAccepted.length).toBeGreaterThanOrEqual(9);
    });

    it("missing object → 422 media.object_missing, asset stays 'uploading' (retryable), no purge", () => {
      for (const r of rows.filter((x) => x.axis === "missing_object" && x.createStatus === 200)) {
        expect(r.completeStatus, r.id).toBe(422);
        expect(r.completeCode, r.id).toBe("media.object_missing");
        expect(r.dbStatus, r.id).toBe("uploading");
        expect(r.deletedAt, r.id).toBe(false);
        expect(r.purgeQueued, r.id).toBe(false);
        expect(r.playbackStatus, r.id).toBe(409);
      }
    });

    it("stored object 1 byte larger than declared → 422 media.size_exceeded (corrupted_media), asset deleted + purge queued, playback 404", () => {
      for (const r of rows.filter((x) => x.axis === "oversized_stored" && x.createStatus === 200)) {
        expect(r.completeStatus, r.id).toBe(422);
        expect(r.completeCode, r.id).toBe("media.size_exceeded");
        expect(r.completeKind, r.id).toBe("corrupted_media");
        expect(r.dbStatus, r.id).toBe("deleted");
        expect(r.deletedAt, r.id).toBe(true);
        expect(r.purgeQueued, r.id).toBe(true);
        expect(r.processQueued, r.id).toBe(false);
        expect(r.playbackStatus, r.id).toBe(404);
      }
    });

    it("stored content type ≠ declared → 422 media.content_type_mismatch, asset deleted + purge queued", () => {
      for (const r of rows.filter(
        (x) => x.axis === "wrong_stored_type" && x.createStatus === 200,
      )) {
        expect(r.completeStatus, r.id).toBe(422);
        expect(r.completeCode, r.id).toBe("media.content_type_mismatch");
        expect(r.dbStatus, r.id).toBe("deleted");
        expect(r.purgeQueued, r.id).toBe(true);
        expect(r.processQueued, r.id).toBe(false);
      }
    });

    it("stored checksum ≠ declared sha256 → 422 media.checksum_mismatch, asset deleted + purge queued", () => {
      for (const r of rows.filter(
        (x) => x.axis === "checksum_mismatch" && x.createStatus === 200,
      )) {
        expect(r.completeStatus, r.id).toBe(422);
        expect(r.completeCode, r.id).toBe("media.checksum_mismatch");
        expect(r.dbStatus, r.id).toBe("deleted");
        expect(r.purgeQueued, r.id).toBe(true);
        expect(r.processQueued, r.id).toBe(false);
      }
    });

    it("rejected completions are idempotent: a second complete on a purged asset is 404, a second complete on a missing-object asset is still 422 (retryable), a second complete on a ready asset is 404 not a re-queue", async () => {
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const results: Record<string, unknown> = {};
      for (const axis of ["honest", "missing_object", "checksum_mismatch"] as Axis[]) {
        const create = await app.inject({
          method: "POST",
          url: "/v1/media/uploads",
          headers: auth(userToken),
          payload: {
            kind: "raw_video",
            filename: base.fileName,
            bytes: base.bytes,
            contentType: base.claimedContentType,
            sha256: base.sha256,
          },
        });
        const { mediaAssetId } = create.json() as { mediaAssetId: string };
        const objectKey = (
          (await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [mediaAssetId]))
            .rows[0] as { object_key: string }
        ).object_key;
        if (axis !== "missing_object") store.objects.set(objectKey, base.bytes);
        if (axis === "checksum_mismatch")
          store.storedChecksum.set(objectKey, sha256HexToBase64("00".repeat(32)));
        const first = await app.inject({
          method: "POST",
          url: `/v1/media/${mediaAssetId}/complete`,
          headers: auth(userToken),
        });
        const second = await app.inject({
          method: "POST",
          url: `/v1/media/${mediaAssetId}/complete`,
          headers: auth(userToken),
        });
        const jobs = await drainQueue();
        results[axis] = {
          first: first.statusCode,
          second: second.statusCode,
          secondCode: (second.json() as { error?: { code?: string } }).error?.code ?? null,
          processJobs: jobs.filter(
            (j) => j.kind === "media.process" && j.mediaAssetId === mediaAssetId,
          ).length,
          purgeJobs: jobs.filter((j) => j.kind === "media.purge" && j.mediaAssetId === mediaAssetId)
            .length,
        };
      }
      scenarios.push({ scenario: "double_complete", observed: results });
      expect(results["honest"]).toEqual({
        first: 200,
        second: 404,
        secondCode: "media.not_found",
        processJobs: 1,
        purgeJobs: 0,
      });
      expect(results["missing_object"]).toEqual({
        first: 422,
        second: 422,
        secondCode: "media.object_missing",
        processJobs: 0,
        purgeJobs: 0,
      });
      expect(results["checksum_mismatch"]).toEqual({
        first: 422,
        second: 404,
        secondCode: "media.not_found",
        processJobs: 0,
        purgeJobs: 1,
      });
    }, 60_000);

    it("declaration-level spoofs are typed 4xx with no row: non-video type, image type on raw_video, >500 MiB, non-hex/uppercase/short sha256, 201-char filename", async () => {
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const before = Number((await pool.query("SELECT count(*) FROM media_asset")).rows[0].count);
      const cases: Array<{
        name: string;
        body: Record<string, unknown>;
        status: number;
        code: string;
      }> = [
        {
          name: "video/x-matroska",
          body: { contentType: "video/x-matroska" },
          status: 422,
          code: "media.unsupported_type",
        },
        {
          name: "video/webm",
          body: { contentType: "video/webm" },
          status: 422,
          code: "media.unsupported_type",
        },
        {
          name: "image/png on raw_video",
          body: { contentType: "image/png" },
          status: 422,
          code: "media.unsupported_type",
        },
        {
          name: "text/plain",
          body: { contentType: "text/plain" },
          status: 422,
          code: "media.unsupported_type",
        },
        {
          name: "audio/mp4",
          body: { contentType: "audio/mp4" },
          status: 422,
          code: "media.unsupported_type",
        },
        {
          name: "video/mp4; codecs=avc1 (parameters)",
          body: { contentType: "video/mp4; codecs=avc1" },
          status: 422,
          code: "media.unsupported_type",
        },
        {
          name: "VIDEO/MP4 (case)",
          body: { contentType: "VIDEO/MP4" },
          status: 422,
          code: "media.unsupported_type",
        },
        {
          name: "500 MiB + 1",
          body: { bytes: 500 * 1024 * 1024 + 1 },
          status: 400,
          code: "validation.upload",
        },
        {
          name: "uppercase sha",
          body: { sha256: base.sha256.toUpperCase() },
          status: 400,
          code: "validation.upload",
        },
        {
          name: "63-char sha",
          body: { sha256: base.sha256.slice(1) },
          status: 400,
          code: "validation.upload",
        },
        {
          name: "base64 sha",
          body: { sha256: Buffer.from(base.sha256, "hex").toString("base64") },
          status: 400,
          code: "validation.upload",
        },
        {
          name: "201-char filename",
          body: { filename: "a".repeat(197) + ".mp4" },
          status: 400,
          code: "validation.upload",
        },
        { name: "negative bytes", body: { bytes: -1 }, status: 400, code: "validation.upload" },
        { name: "float bytes", body: { bytes: 1.5 }, status: 400, code: "validation.upload" },
      ];
      const observed: Array<{ name: string; status: number; code: string | null }> = [];
      for (const c of cases) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/media/uploads",
          headers: auth(userToken),
          payload: {
            kind: "raw_video",
            filename: base.fileName,
            bytes: base.bytes,
            contentType: base.claimedContentType,
            sha256: base.sha256,
            ...c.body,
          },
        });
        const code = (res.json() as { error?: { code?: string } }).error?.code ?? null;
        observed.push({ name: c.name, status: res.statusCode, code });
        expect(res.statusCode, c.name).toBe(c.status);
        expect(code, c.name).toBe(c.code);
      }
      const after = Number((await pool.query("SELECT count(*) FROM media_asset")).rows[0].count);
      scenarios.push({
        scenario: "declaration_spoofs",
        observed: { observed, rowsCreated: after - before },
      });
      expect(after - before).toBe(0);
    }, 60_000);

    it("OBSERVED: the completion size check is an upper bound only — a stored object SMALLER than declared is accepted when the storage-reported checksum matches", async () => {
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const create = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(userToken),
        payload: {
          kind: "raw_video",
          filename: base.fileName,
          bytes: base.bytes,
          contentType: base.claimedContentType,
          sha256: base.sha256,
        },
      });
      const { mediaAssetId } = create.json() as { mediaAssetId: string };
      const objectKey = (
        (await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [mediaAssetId]))
          .rows[0] as { object_key: string }
      ).object_key;
      store.objects.set(objectKey, Math.floor(base.bytes / 2));
      const complete = await app.inject({
        method: "POST",
        url: `/v1/media/${mediaAssetId}/complete`,
        headers: auth(userToken),
      });
      const state = await dbState(mediaAssetId);
      await drainQueue();
      scenarios.push({
        scenario: "stored_smaller_than_declared",
        observed: { completeStatus: complete.statusCode, state },
      });
      // The presigned PUT binds exact Content-Length + x-amz-checksum-sha256, so
      // real S3 cannot store a half object under a matching checksum; this
      // documents that the API relies entirely on storage for that guarantee.
      expect(complete.statusCode).toBe(200);
      expect(state?.status).toBe("ready");
    }, 60_000);

    it("OBSERVED: a storage backend that reports no content type (null) skips the content-type check", async () => {
      const base = manifest.cases.find((c) => c.id === "base_720p30_aac")!;
      const create = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(userToken),
        payload: {
          kind: "raw_video",
          filename: base.fileName,
          bytes: base.bytes,
          contentType: base.claimedContentType,
          sha256: base.sha256,
        },
      });
      const { mediaAssetId } = create.json() as { mediaAssetId: string };
      const objectKey = (
        (await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [mediaAssetId]))
          .rows[0] as { object_key: string }
      ).object_key;
      store.objects.set(objectKey, base.bytes);
      store.storedContentType.set(objectKey, null);
      const complete = await app.inject({
        method: "POST",
        url: `/v1/media/${mediaAssetId}/complete`,
        headers: auth(userToken),
      });
      await drainQueue();
      scenarios.push({
        scenario: "null_stored_content_type",
        observed: { completeStatus: complete.statusCode, state: await dbState(mediaAssetId) },
      });
      expect(complete.statusCode).toBe(200);
    }, 60_000);

    it("downstream (production worker wiring, transcoder: null): junk masters accepted by the API stay 'ready' and are never inspected", async () => {
      const junk = manifest.cases.filter(
        (c) => c.expected === "typed_reject" && c.id !== "empty_file",
      );
      const ids: string[] = [];
      for (const c of junk) {
        const create = await app.inject({
          method: "POST",
          url: "/v1/media/uploads",
          headers: auth(userToken),
          payload: {
            kind: "raw_video",
            filename: c.fileName,
            bytes: c.bytes,
            contentType: c.claimedContentType,
            sha256: c.sha256,
          },
        });
        const { mediaAssetId } = create.json() as { mediaAssetId: string };
        const objectKey = (
          (await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [mediaAssetId]))
            .rows[0] as { object_key: string }
        ).object_key;
        store.objects.set(objectKey, c.bytes);
        const complete = await app.inject({
          method: "POST",
          url: `/v1/media/${mediaAssetId}/complete`,
          headers: auth(userToken),
        });
        expect(complete.statusCode, c.id).toBe(200);
        ids.push(mediaAssetId);
      }
      const log: string[] = [];
      const deps: WorkerDeps = {
        pool,
        queue,
        objectStore: {
          deleteObject: async (k) => {
            store.objects.delete(k);
          },
          listObjects: async () => [],
        },
        transcoder: null,
        log: (l) => log.push(l),
      };
      let processed = 0;
      for (let i = 0; i < 5; i++) processed += (await runOnce(deps)).jobs;
      const statuses = await Promise.all(ids.map((id) => dbState(id)));
      scenarios.push({
        scenario: "downstream_null_transcoder",
        observed: {
          processed,
          statuses: statuses.map((s) => s?.status),
          notes: log.filter((l) => l.startsWith("media.process")).slice(0, 3),
          userId,
        },
      });
      expect(processed).toBe(junk.length);
      expect(statuses.every((s) => s?.status === "ready")).toBe(true);
      expect(log.filter((l) => l.includes("no transcoder configured")).length).toBe(junk.length);
    }, 120_000);
  },
);
