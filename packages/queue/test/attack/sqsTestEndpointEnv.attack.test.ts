import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSqsTestEndpoint } from "../sqsTestEndpoint.js";

/**
 * P0-05 adversarial tests (attack branch): explicit-env precedence, opt-out,
 * replayed/duplicate resolution and the wiring of the resolver into the
 * `describe.skipIf(!endpoint)` gate of sqs.integration.test.ts.
 *
 * Contract under test (sqsTestEndpoint.ts): explicit env (any value, "" =
 * do not probe) > reachable docker-compose default > "" (skip).
 */

const openServers: Server[] = [];

async function liveBroker(): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 400;
    res.end("Bad Request");
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe("attack: explicit SQS_ENDPOINT_TEST values", () => {
  it("an explicit empty value opts out even when the broker is live (documented, not silent auto-skip)", async () => {
    const live = await liveBroker();
    await expect(resolveSqsTestEndpoint({ SQS_ENDPOINT_TEST: "" }, live)).resolves.toBe("");
  });

  it.each([
    " ",
    "\n",
    "0",
    "false",
    "null",
    "undefined",
    "localhost:9324",
    "https://localhost:9324",
  ])(
    "explicit %j is returned verbatim, so the gate RUNS the suite and the SDK fails loudly (never a silent skip)",
    async (explicit) => {
      const live = await liveBroker();
      const endpoint = await resolveSqsTestEndpoint({ SQS_ENDPOINT_TEST: explicit }, live);
      expect(endpoint).toBe(explicit);
      // `describe.skipIf(!endpoint)` — every non-empty string is truthy.
      expect(!endpoint).toBe(false);
    },
  );

  it("an explicit endpoint wins over a live default (no probe of the default happens)", async () => {
    let probed = 0;
    const server = createServer((_req, res) => {
      probed += 1;
      res.statusCode = 400;
      res.end();
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    const live = `http://127.0.0.1:${address.port}`;

    await expect(
      resolveSqsTestEndpoint({ SQS_ENDPOINT_TEST: "http://sqs.invalid:1" }, live),
    ).resolves.toBe("http://sqs.invalid:1");
    expect(probed).toBe(0);
  });

  it("the default argument reads process.env at call time (a later export is honoured, an unset is probed)", async () => {
    const previous = process.env["SQS_ENDPOINT_TEST"];
    try {
      process.env["SQS_ENDPOINT_TEST"] = "http://explicit.invalid:1";
      await expect(resolveSqsTestEndpoint()).resolves.toBe("http://explicit.invalid:1");
      delete process.env["SQS_ENDPOINT_TEST"];
      const live = await liveBroker();
      await expect(resolveSqsTestEndpoint(undefined, live)).resolves.toBe(live);
    } finally {
      if (previous === undefined) delete process.env["SQS_ENDPOINT_TEST"];
      else process.env["SQS_ENDPOINT_TEST"] = previous;
    }
  });
});

describe("attack: replayed / concurrent resolution", () => {
  it("20 concurrent resolutions against the same live default all agree", async () => {
    const live = await liveBroker();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => resolveSqsTestEndpoint({}, live)),
    );
    expect(new Set(results)).toEqual(new Set([live]));
  });

  it("a broker that dies between two resolutions flips the verdict to skip (no cached stale 'up')", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 400;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    const url = `http://127.0.0.1:${address.port}`;

    await expect(resolveSqsTestEndpoint({}, url)).resolves.toBe(url);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(resolveSqsTestEndpoint({}, url)).resolves.toBe("");
  });
});

describe("attack: sqs.integration.test.ts gate wiring", () => {
  const source = readFileSync(join(__dirname, "..", "sqs.integration.test.ts"), "utf8");

  it("resolves the endpoint exactly once at module scope and gates on its emptiness", () => {
    expect(source.match(/resolveSqsTestEndpoint\(/g)?.length).toBe(1);
    expect(source).toMatch(/const endpoint = await resolveSqsTestEndpoint\(\)/);
    expect(source).toMatch(/describe\.skipIf\(!endpoint\)/);
  });

  it("does not fall back to a hard-coded endpoint when the resolver says skip", () => {
    expect(source).not.toMatch(/endpoint\s*(\|\||\?\?)\s*["']http/);
    expect(source).not.toMatch(/process\.env\[["']SQS_ENDPOINT_TEST["']\]/);
  });

  it("no other workspace test file still gates SQS on a raw env read", () => {
    const queueTestDir = join(__dirname, "..");
    const rawReads = ["queue.test.ts", "sqs.integration.test.ts"].filter((file) =>
      /process\.env\[["']SQS_ENDPOINT_TEST["']\]|process\.env\.SQS_ENDPOINT_TEST/.test(
        readFileSync(join(queueTestDir, file), "utf8"),
      ),
    );
    expect(rawReads).toEqual([]);
  });
});
