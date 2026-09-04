/**
 * Abandoned-upload retention probe (legacy Fastify media API + real MinIO +
 * real PostgreSQL + real media worker).
 *
 * Question: when a client obtains presigned upload URLs, PUTs the bytes, and
 * never calls `complete`, does ANYTHING reclaim the objects? The API leaves
 * `media_asset.expires_at` NULL, the worker's retention sweep only acts on
 * `expires_at`, fixed-window kinds (share_video) or a user-set retention, and
 * the Terraform lifecycle rule `raw-clip-retention` only matches objects
 * tagged `retention=default` — which nothing in the code base writes. This
 * probe executes that path and reports what is left behind.
 *
 * Also measures the only bound the API imposes on how many such uploads one
 * credential can open per minute (the expensive-route rate limit).
 *
 *   DATABASE_URL_TEST=… S3_TEST_*=… pnpm exec tsx test/support/abandonedUploadProbe.ts \
 *     --uploads 20 --backdate-days 60 --out <dir>
 *
 * Exit 0 when every abandoned object was reclaimed after the backdated sweep,
 * 1 when any survived (the finding), 2 for configuration errors.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "@pickle/media-worker/worker";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import {
  adminClient,
  buildHarnessStore,
  harnessEnvFromProcess,
  rawRequest,
} from "./storagePolicyHarness.js";

interface Args {
  uploads: number;
  backdateDays: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { uploads: 20, backdateDays: 60, out: "/tmp/abandoned-upload-probe" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--uploads" && v) {
      args.uploads = Number(v);
      i++;
    } else if (a === "--backdate-days" && v) {
      args.backdateDays = Number(v);
      i++;
    } else if (a === "--out" && v) {
      args.out = v;
      i++;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(args.uploads) || args.uploads <= 0)
    throw new Error("--uploads must be > 0");
  if (!Number.isInteger(args.backdateDays) || args.backdateDays <= 0)
    throw new Error("--backdate-days must be > 0");
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const testUrl = process.env["DATABASE_URL_TEST"];
  const env = harnessEnvFromProcess(process.env);
  if (!testUrl || !env) {
    console.error(
      "DATABASE_URL_TEST and S3_TEST_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET are required",
    );
    return 2;
  }
  mkdirSync(args.out, { recursive: true });

  const schemaName = `abandoned_probe_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
  const adminPool = new pg.Pool({ connectionString: testUrl });
  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  const scoped = new URL(testUrl);
  scoped.searchParams.set("options", `-c search_path=${schemaName}`);
  const pool = new pg.Pool({ connectionString: scoped.toString() });
  const admin = adminClient(env);
  const createdKeys: string[] = [];

  try {
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    const secret = "abandoned-upload-probe-secret-0123456789";
    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      databaseUrl: scoped.toString(),
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
    const queue = new InMemoryJobQueue();
    // Rate limiting stays at production defaults on purpose: it is the only
    // per-credential bound on how many uploads can be opened, and we measure it.
    const app = buildApp(config, { queue, objectStore: buildHarnessStore(env) });
    const workerDeps: WorkerDeps = {
      pool,
      queue,
      objectStore: {
        deleteObject: async (key) => {
          await admin.send(new DeleteObjectCommand({ Bucket: env.bucket, Key: key }));
        },
        listObjects: async (prefix) => {
          const page = await admin.send(
            new ListObjectsV2Command({ Bucket: env.bucket, Prefix: prefix }),
          );
          return (page.Contents ?? []).map((o) => o.Key ?? "").filter((k) => k.length > 0);
        },
      },
      transcoder: null,
      log: () => {},
    };
    const token = await new DevTokenVerifier("test", secret).mint(`abandoned|${randomUUID()}`);
    const auth = { authorization: `Bearer ${token}` };
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth,
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    if (bootstrap.statusCode !== 200)
      throw new Error(`bootstrap ${bootstrap.statusCode}: ${bootstrap.body}`);
    const userId = (bootstrap.json() as { user: { id: string } }).user.id;
    const settings = await app.inject({
      method: "PATCH",
      url: "/v1/me/settings",
      headers: auth,
      payload: { cloudSyncEnabled: true },
    });
    if (settings.statusCode !== 200)
      throw new Error(`settings ${settings.statusCode}: ${settings.body}`);

    // 1. Open N uploads, PUT the bytes, never complete.
    const body = Buffer.alloc(4096, 1);
    const sha256 = createHash("sha256").update(body).digest("hex");
    let created = 0;
    let rateLimitedAt: number | null = null;
    const putStatuses: number[] = [];
    for (let i = 0; i < args.uploads; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth,
        payload: {
          kind: "raw_video",
          filename: `abandoned-${i}.mp4`,
          bytes: body.length,
          contentType: "video/mp4",
          sha256,
        },
      });
      if (res.statusCode === 429) {
        rateLimitedAt = i;
        break;
      }
      if (res.statusCode !== 200) throw new Error(`upload create ${res.statusCode}: ${res.body}`);
      const ticket = res.json() as {
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
        mediaAssetId: string;
      };
      const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
        ticket.mediaAssetId,
      ]);
      createdKeys.push(row.rows[0].object_key as string);
      const put = await rawRequest("PUT", ticket.uploadUrl, ticket.requiredHeaders, body);
      putStatuses.push(put.status);
      created++;
    }

    const countObjects = async (): Promise<number> => {
      const page = await admin.send(
        new ListObjectsV2Command({ Bucket: env.bucket, Prefix: `media/${userId}/` }),
      );
      return (page.Contents ?? []).filter((o) => createdKeys.includes(o.Key ?? "")).length;
    };
    const objectsAfterPut = await countObjects();
    const tagsSample = createdKeys.length
      ? ((
          await admin.send(
            new GetObjectTaggingCommand({ Bucket: env.bucket, Key: createdKeys[0]! }),
          )
        ).TagSet ?? [])
      : [];

    // 2. Age the rows past any plausible retention window and run the worker.
    const aged = await pool.query(
      `UPDATE media_asset SET created_at = now() - make_interval(days => $2::int)
       WHERE owner_user_id = $1 AND status = 'uploading' RETURNING id, expires_at`,
      [userId, args.backdateDays],
    );
    const sweeps: Array<{ jobs: number; deletions: number; swept: number; expired: number }> = [];
    for (let i = 0; i < 3; i++) sweeps.push(await runOnce(workerDeps));
    const after = await pool.query(
      `SELECT status, count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 GROUP BY status ORDER BY status`,
      [userId],
    );
    const objectsAfterSweep = await countObjects();

    // 3. Ask the API what it thinks of one abandoned asset (still 'uploading').
    const firstId = aged.rows[0]?.id as string | undefined;
    const apiView = firstId
      ? await app.inject({ method: "GET", url: `/v1/media/${firstId}`, headers: auth })
      : null;

    const report = {
      generatedAt: new Date().toISOString(),
      endpoint: env.endpoint,
      bucket: env.bucket,
      args,
      userId,
      uploadsOpened: created,
      rateLimitedAtIndex: rateLimitedAt,
      putStatusHistogram: putStatuses.reduce<Record<string, number>>((acc, s) => {
        acc[String(s)] = (acc[String(s)] ?? 0) + 1;
        return acc;
      }, {}),
      objectsAfterPut,
      objectTagSetSample: tagsSample,
      rowsBackdated: aged.rowCount,
      expiresAtNullOnAllRows: aged.rows.every((r) => r.expires_at === null),
      workerRuns: sweeps,
      mediaAssetStatusAfterSweep: after.rows,
      objectsAfterSweep,
      apiViewOfAbandonedAsset: apiView
        ? { status: apiView.statusCode, body: apiView.json() }
        : null,
      verdict: objectsAfterSweep === 0 ? "reclaimed" : "orphaned",
    };
    writeFileSync(join(args.out, "abandoned-upload-probe.json"), JSON.stringify(report, null, 2));
    console.log(
      `abandoned uploads: opened=${created} objects_after_put=${objectsAfterPut} objects_after_${args.backdateDays}d_sweep=${objectsAfterSweep} tags=${JSON.stringify(tagsSample)} → ${report.verdict} (${join(args.out, "abandoned-upload-probe.json")})`,
    );
    await app.close();
    return objectsAfterSweep === 0 ? 0 : 1;
  } finally {
    for (const key of createdKeys) {
      await admin.send(new DeleteObjectCommand({ Bucket: env.bucket, Key: key }));
    }
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
