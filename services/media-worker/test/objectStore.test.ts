import { describe, expect, it } from "vitest";
import { buildObjectDeleter } from "../src/objectStore.js";

/**
 * Wave H gate 8 regression: the worker entrypoint must build a real storage
 * deleter from configuration. With a null deleter, purge and account deletion
 * stall and deleted media bytes stay in the bucket forever.
 */

describe("buildObjectDeleter", () => {
  it("returns null when no media bucket is configured (worker then refuses to claim purge)", () => {
    expect(buildObjectDeleter({})).toBeNull();
  });

  it("builds a deleter that can delete and list derived artifacts when configured", () => {
    const deleter = buildObjectDeleter({
      S3_MEDIA_BUCKET: "pickle-media-test",
      AWS_REGION: "us-west-2",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(deleter).not.toBeNull();
    expect(typeof deleter!.deleteObject).toBe("function");
    expect(typeof deleter!.listObjects).toBe("function");
  });
});
