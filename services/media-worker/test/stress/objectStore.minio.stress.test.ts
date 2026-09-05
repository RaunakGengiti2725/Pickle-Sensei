import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildObjectDeleter } from "../../src/objectStore.js";
import { bounded } from "./faultKit.js";

/**
 * Real S3-protocol faults against MinIO (docker compose service `minio`).
 * Runs only when S3_ENDPOINT_TEST is set, e.g.
 *   S3_ENDPOINT_TEST=http://localhost:9000 S3_ACCESS_KEY_ID_TEST=… S3_SECRET_ACCESS_KEY_TEST=…
 * Credentials come from the environment only (docker-compose.yml defines the
 * local ones); nothing is hard-coded here.
 *
 * Faults: >1000 derived objects (pagination), idempotent delete of a missing
 * key, wrong bucket, wrong credentials, refused endpoint, and an endpoint that
 * accepts TCP but never answers (black hole).
 */

const endpoint = process.env["S3_ENDPOINT_TEST"];
const accessKeyId = process.env["S3_ACCESS_KEY_ID_TEST"];
const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY_TEST"];
const enabled = Boolean(endpoint && accessKeyId && secretAccessKey);
const bucket = `pickle-stress-${randomUUID().slice(0, 8)}`;

function envFor(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    S3_MEDIA_BUCKET: bucket,
    AWS_REGION: "us-east-1",
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    ...overrides,
  };
}

export async function listenBlackHole(): Promise<{
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    // Accept, read, never respond.
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, url: `http://127.0.0.1:${address.port}`, close };
}

export async function closedPortUrl(): Promise<string> {
  const hole = await listenBlackHole();
  await hole.close();
  return hole.url;
}

describe.skipIf(!enabled)("S3ObjectDeleter against MinIO (failure injection)", () => {
  let client: S3Client;

  beforeAll(async () => {
    client = new S3Client({
      region: "us-east-1",
      endpoint: endpoint!,
      forcePathStyle: true,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }, 30_000);

  afterAll(async () => {
    // Best effort: leave nothing behind in the shared local MinIO.
    const deleter = buildObjectDeleter(envFor());
    const rest = await deleter!.listObjects!("");
    for (const key of rest) await deleter!.deleteObject(key);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  async function put(key: string): Promise<void> {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "x" }));
  }

  /** The exact sequence worker.ts `deleteObjectAndDerived` performs. */
  async function purgeLikeWorker(master: string): Promise<string[]> {
    const deleter = buildObjectDeleter(envFor())!;
    const listed = await deleter.listObjects!(`${master}/`);
    for (const key of listed) await deleter.deleteObject(key);
    await deleter.deleteObject(master);
    return listed;
  }

  async function keysUnder(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of page.Contents ?? []) if (o.Key) out.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  it("lists >1000 derived objects across pages and a `/`-boundary sibling is untouched", async () => {
    // Derived objects only (no master object at the prefix root) so this
    // measures pagination, not the key/prefix collision pinned below.
    const master = `media/${randomUUID()}/${randomUUID()}/master.mp4`;
    const n = 1105;
    const puts: Promise<void>[] = [];
    for (let i = 0; i < n; i++) puts.push(put(`${master}/frame-${String(i).padStart(4, "0")}.jpg`));
    const sibling = `${master}.bak`;
    puts.push(put(sibling));
    await Promise.all(puts);

    const listed = await purgeLikeWorker(master);
    expect(listed).toHaveLength(n);
    expect(await keysUnder(master)).toEqual([sibling]);
    await buildObjectDeleter(envFor())!.deleteObject(sibling);
  }, 120_000);

  it.fails(
    "purging a master whose derived objects live under `<masterKey>/` must remove the derived objects too",
    async () => {
      // MinIO (RELEASE.2025-09 in docker-compose) hides `<key>/…` objects
      // from ListObjectsV2 while an object named exactly `<key>` exists, so
      // the worker's list-then-delete-master order finds nothing, deletes
      // the master, nulls object_key and leaves the derived files with no
      // DB pointer. (AWS S3 keys are flat and would list them — INFERRED.)
      const master = `media/${randomUUID()}/${randomUUID()}/master.mp4`;
      await put(master);
      await put(`${master}/normalized.mp4`);
      await put(`${master}/thumb.jpg`);

      const listed = await purgeLikeWorker(master);
      const remaining = await keysUnder(`${master}/`);
      // Cleanup so the shared MinIO does not accumulate orphans, then assert.
      for (const key of remaining) await buildObjectDeleter(envFor())!.deleteObject(key);
      expect(listed, "derived objects listed while master exists").toHaveLength(2);
      expect(remaining, "derived objects orphaned after purge").toEqual([]);
    },
  );

  it("deleting a key that does not exist resolves (purge retries are idempotent)", async () => {
    const deleter = buildObjectDeleter(envFor())!;
    const settled = await bounded(
      () => deleter.deleteObject(`media/${randomUUID()}/nope.mp4`),
      10_000,
    );
    expect(settled.kind).toBe("resolved");
    const listed = await bounded(() => deleter.listObjects!(`media/${randomUUID()}/`), 10_000);
    expect(listed).toMatchObject({ kind: "resolved", value: [] });
  });

  it("a missing bucket is a typed rejection, not a hang or a fake success", async () => {
    const deleter = buildObjectDeleter(
      envFor({ S3_MEDIA_BUCKET: `does-not-exist-${randomUUID().slice(0, 8)}` }),
    )!;
    const del = await bounded(() => deleter.deleteObject("media/x/master.mp4"), 15_000);
    expect(del.kind).toBe("rejected");
    if (del.kind === "rejected") expect(del.error).toMatch(/NoSuchBucket/);
    const list = await bounded(() => deleter.listObjects!("media/x/master.mp4/"), 15_000);
    expect(list.kind).toBe("rejected");
  });

  it("wrong credentials are a typed rejection", async () => {
    const deleter = buildObjectDeleter(
      envFor({ S3_ACCESS_KEY_ID: "wrong-access-key", S3_SECRET_ACCESS_KEY: "wrong-secret-key" }),
    )!;
    const del = await bounded(() => deleter.deleteObject("media/x/master.mp4"), 15_000);
    expect(del.kind).toBe("rejected");
    if (del.kind === "rejected")
      expect(del.error).toMatch(/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied/);
  });

  it("a refused endpoint rejects within the SDK retry budget (no hang)", async () => {
    const deleter = buildObjectDeleter(envFor({ S3_ENDPOINT: await closedPortUrl() }))!;
    const del = await bounded(() => deleter.deleteObject("media/x/master.mp4"), 30_000);
    expect(del.kind).toBe("rejected");
    if (del.kind === "rejected") expect(del.error).toMatch(/ECONNREFUSED/);
  }, 40_000);

  it.fails(
    "an endpoint that accepts TCP and never answers: the delete must settle (timeout), not hang",
    async () => {
      const hole = await listenBlackHole();
      try {
        const deleter = buildObjectDeleter(envFor({ S3_ENDPOINT: hole.url }))!;
        // 20 s is far beyond any sane per-request budget for a delete. The
        // S3Client in objectStore.ts sets no requestTimeout/connectionTimeout,
        // so the call is still pending when the guard fires.
        const del = await bounded(() => deleter.deleteObject("media/x/master.mp4"), 20_000);
        expect(
          del.kind,
          `DeleteObject against a black-hole endpoint: ${del.kind} after ${del.ms}ms`,
        ).toBe("rejected");
      } finally {
        await hole.close();
      }
    },
    30_000,
  );
});
