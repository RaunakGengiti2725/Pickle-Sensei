import { afterEach, describe, expect, it } from "vitest";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import {
  DEFAULT_LOCAL_SQS_ENDPOINT,
  isHttpEndpointReachable,
  resolveSqsTestEndpoint,
} from "../sqsTestEndpoint.js";

/**
 * P0-05 adversarial tests (attack branch): boundary values for the probe's
 * `timeoutMs` and for the resolver's explicit-env / fallback inputs.
 *
 * `isHttpEndpointReachable` is typed `(url: string, timeoutMs?: number) =>
 * Promise<boolean>` and documents "connection refused / timeout / non-http
 * URL count as unreachable". A boolean-returning probe must therefore never
 * hang and never reject for a numeric `timeoutMs` — the two ways a probe can
 * turn a `describe.skipIf(!endpoint)` gate into a hung or crashed `pnpm test`.
 */

const HUNG = Symbol("probe did not settle");

function settleWithin<T>(promise: Promise<T>, capMs: number): Promise<T | typeof HUNG> {
  return Promise.race([
    promise,
    new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), capMs).unref()),
  ]);
}

const openServers: TcpServer[] = [];
const openSockets = new Set<Socket>();

async function silentPeer(): Promise<string> {
  const server = createTcpServer((socket) => openSockets.add(socket));
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  await Promise.all(
    openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe("attack: timeoutMs boundary values", () => {
  it("timeoutMs = 0 must not disable the deadline (a silent peer must still resolve false)", async () => {
    const url = await silentPeer();
    const verdict = await settleWithin(isHttpEndpointReachable(url, 0), 1500);
    expect(verdict).toBe(false);
  });

  it.each([
    ["NaN", Number.NaN],
    ["-1", -1],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("timeoutMs = %s resolves to a boolean instead of rejecting", async (_label, timeoutMs) => {
    const url = await silentPeer();
    const verdict = await settleWithin(isHttpEndpointReachable(url, timeoutMs), 1500);
    expect(typeof verdict).toBe("boolean");
  });

  it("a fractional timeoutMs is honoured (1.5ms against a silent peer -> false)", async () => {
    const url = await silentPeer();
    await expect(isHttpEndpointReachable(url, 1.5)).resolves.toBe(false);
  });
});

describe("attack: URL boundary values for the probe", () => {
  it.each([
    "",
    " ",
    "http://",
    "localhost:9324",
    "http://localhost:99999",
    "http://localhost:0",
    "https://localhost:9324",
    "ftp://localhost:9324",
    "file:///etc/hosts",
    "http://[::1",
  ])("%j is unreachable without hanging or throwing", async (url) => {
    const verdict = await settleWithin(isHttpEndpointReachable(url, 300), 1500);
    expect(verdict).toBe(false);
  });

  it("a probe URL carrying a path and query is honoured as given", async () => {
    // Nothing listens here; the point is that URL parsing accepts the shape
    // and the probe settles false rather than throwing on the path/query.
    await expect(
      isHttpEndpointReachable("http://127.0.0.1:1/queue/default?Action=ListQueues", 300),
    ).resolves.toBe(false);
  });
});

describe("attack: resolver fallback boundary values", () => {
  it("an unset env with an empty fallback skips (no probe of an empty URL)", async () => {
    await expect(resolveSqsTestEndpoint({}, "")).resolves.toBe("");
  });

  it("an unset env with a non-http fallback skips instead of running the suite against it", async () => {
    await expect(resolveSqsTestEndpoint({}, "https://localhost:9324")).resolves.toBe("");
    await expect(resolveSqsTestEndpoint({}, "not a url")).resolves.toBe("");
  });

  it("the default fallback is exactly the docker-compose ElasticMQ port and is http", () => {
    const parsed = new URL(DEFAULT_LOCAL_SQS_ENDPOINT);
    expect(parsed.protocol).toBe("http:");
    expect(parsed.hostname).toBe("localhost");
    expect(parsed.port).toBe("9324");
  });
});
