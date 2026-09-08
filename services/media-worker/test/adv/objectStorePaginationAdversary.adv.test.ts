import { describe, expect, it, vi } from "vitest";

/**
 * INT-deletion-managed-media adversary (attacked HEAD 30a40650).
 *
 * ADV-W04: derived-artifact listing past the S3 page cap. ListObjectsV2 returns
 * at most 1000 keys per page; a purge that stops at the first page leaves the
 * remaining derived artifacts orphaned in the bucket while the DB says the
 * object is gone. The SDK is replaced by a scripted fake that serves three
 * pages and records the continuation tokens it was asked for.
 */

interface ListInput {
  Bucket: string;
  Prefix: string;
  ContinuationToken?: string;
}

const scripted = vi.hoisted(() => {
  const pages = new Map<string | undefined, { keys: string[]; next?: string }>();
  const requests: ListInput[] = [];
  const deletes: string[] = [];
  return { pages, requests, deletes };
});

vi.mock("@aws-sdk/client-s3", () => {
  class ListObjectsV2Command {
    constructor(public readonly input: ListInput) {}
  }
  class DeleteObjectCommand {
    constructor(public readonly input: { Bucket: string; Key: string }) {}
  }
  class S3Client {
    constructor(_config: unknown) {}
    async send(command: ListObjectsV2Command | DeleteObjectCommand): Promise<unknown> {
      if (command instanceof ListObjectsV2Command) {
        scripted.requests.push(command.input);
        const page = scripted.pages.get(command.input.ContinuationToken);
        if (!page)
          throw new Error(`unexpected continuation token ${command.input.ContinuationToken}`);
        return {
          Contents: page.keys.map((Key) => ({ Key })),
          IsTruncated: page.next !== undefined,
          NextContinuationToken: page.next,
        };
      }
      scripted.deletes.push(command.input.Key);
      return {};
    }
  }
  return { S3Client, ListObjectsV2Command, DeleteObjectCommand };
});

import { buildObjectDeleter } from "../../src/objectStore.js";

describe("ADV-W04 S3 derived-artifact listing past the page cap", () => {
  it("follows every continuation token and returns all 2005 derived keys", async () => {
    const prefix = "media/owner/master/";
    const page = (offset: number, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}part-${offset + i}`);
    scripted.pages.set(undefined, { keys: page(0, 1000), next: "tok-1" });
    scripted.pages.set("tok-1", { keys: page(1000, 1000), next: "tok-2" });
    scripted.pages.set("tok-2", { keys: page(2000, 5) });

    const deleter = buildObjectDeleter({ S3_MEDIA_BUCKET: "adv-bucket", AWS_REGION: "us-west-2" });
    expect(deleter).not.toBeNull();
    if (!deleter?.listObjects) throw new Error("listObjects missing on S3 deleter");

    const keys = await deleter.listObjects(prefix);

    expect(keys).toHaveLength(2005);
    expect(new Set(keys).size).toBe(2005);
    expect(scripted.requests.map((r) => r.ContinuationToken)).toEqual([
      undefined,
      "tok-1",
      "tok-2",
    ]);
    expect(scripted.requests.every((r) => r.Prefix === prefix && r.Bucket === "adv-bucket")).toBe(
      true,
    );
  });

  it("a listing failure on a later page rejects instead of returning a partial inventory", async () => {
    const prefix = "media/owner/other/";
    scripted.pages.clear();
    scripted.requests.length = 0;
    scripted.pages.set(undefined, { keys: [`${prefix}a`], next: "broken" });

    const deleter = buildObjectDeleter({ S3_MEDIA_BUCKET: "adv-bucket" });
    if (!deleter?.listObjects) throw new Error("listObjects missing on S3 deleter");

    await expect(deleter.listObjects(prefix)).rejects.toThrow(/unexpected continuation token/);
    expect(scripted.requests).toHaveLength(2);
  });
});
