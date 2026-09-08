import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LOCAL_SQS_ENDPOINT,
  isHttpEndpointReachable,
  resolveSqsTestEndpoint,
} from "./sqsTestEndpoint.js";

/**
 * The @pickle/queue ElasticMQ suite must not silently skip when the
 * docker-compose broker is up but the caller did not export
 * SQS_ENDPOINT_TEST (the manifest acceptance command is a bare `pnpm test`).
 * Resolution order: explicit env (any value, "" = do not probe) > reachable
 * docker-compose default > "" (skip).
 */

async function listenOnEphemeralPort(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    // ElasticMQ answers a bare GET with 400; any HTTP response means "up".
    res.statusCode = 400;
    res.end("Bad Request");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("resolveSqsTestEndpoint", () => {
  it("defaults to the docker-compose ElasticMQ port", () => {
    expect(DEFAULT_LOCAL_SQS_ENDPOINT).toBe("http://localhost:9324");
  });

  it("honours an explicit SQS_ENDPOINT_TEST without probing", async () => {
    const explicit = "http://sqs.invalid:1";
    await expect(resolveSqsTestEndpoint({ SQS_ENDPOINT_TEST: explicit })).resolves.toBe(explicit);
  });

  it("treats an explicit empty SQS_ENDPOINT_TEST as an opt-out (no auto-detect)", async () => {
    const live = await listenOnEphemeralPort();
    try {
      await expect(resolveSqsTestEndpoint({ SQS_ENDPOINT_TEST: "" }, live.url)).resolves.toBe("");
    } finally {
      await live.close();
    }
  });

  it("auto-detects a reachable local broker when the env var is unset", async () => {
    const live = await listenOnEphemeralPort();
    try {
      await expect(isHttpEndpointReachable(live.url)).resolves.toBe(true);
      await expect(resolveSqsTestEndpoint({}, live.url)).resolves.toBe(live.url);
    } finally {
      await live.close();
    }
  });

  it("returns '' (skip) when the env var is unset and nothing listens on the default", async () => {
    const dead = await listenOnEphemeralPort();
    await dead.close();
    await expect(isHttpEndpointReachable(dead.url)).resolves.toBe(false);
    await expect(resolveSqsTestEndpoint({}, dead.url)).resolves.toBe("");
  });

  it("rejects non-http probe targets instead of hanging", async () => {
    await expect(isHttpEndpointReachable("ftp://localhost:9324")).resolves.toBe(false);
    await expect(isHttpEndpointReachable("not a url")).resolves.toBe(false);
  });
});

describe("sqs.integration.test.ts wiring", () => {
  const source = readFileSync(join(__dirname, "sqs.integration.test.ts"), "utf8");

  it("gates the ElasticMQ suite on the resolver, not on a raw env read", () => {
    expect(source).toContain("resolveSqsTestEndpoint(");
    expect(source).not.toMatch(/process\.env\[["']SQS_ENDPOINT_TEST["']\]/);
  });
});
