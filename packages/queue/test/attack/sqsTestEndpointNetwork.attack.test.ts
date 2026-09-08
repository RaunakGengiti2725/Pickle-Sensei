import { afterEach, describe, expect, it } from "vitest";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { isHttpEndpointReachable, resolveSqsTestEndpoint } from "../sqsTestEndpoint.js";

/**
 * P0-05 adversarial tests (attack branch) for the ElasticMQ auto-detect probe
 * in test/sqsTestEndpoint.ts.
 *
 * The probe is what decides whether a bare `pnpm test` RUNS or SKIPS the SQS
 * integration suite. Its documented contract is: connection refused / timeout /
 * non-http URL count as "unreachable" (skip), and `timeoutMs` bounds the probe.
 * These tests hold the probe to that contract at the network failure
 * boundaries: a peer that accepts and never answers, a peer that drips bytes
 * slowly, a peer that answers with 3xx/429/5xx, a peer that never terminates
 * its body, and many probes racing concurrently.
 */

const HUNG = Symbol("probe did not settle");

function settleWithin<T>(promise: Promise<T>, capMs: number): Promise<T | typeof HUNG> {
  return Promise.race([
    promise,
    new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), capMs).unref()),
  ]);
}

function portOf(server: TcpServer | HttpServer): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

function listen(server: TcpServer | HttpServer): Promise<string> {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${portOf(server)}`));
  });
}

const openServers: Array<TcpServer | HttpServer> = [];
const openSockets = new Set<Socket>();

function track<S extends TcpServer | HttpServer>(server: S): S {
  openServers.push(server);
  return server;
}

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if ("closeAllConnections" in server) server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("attack: network failure boundaries of isHttpEndpointReachable", () => {
  it("a peer that accepts the TCP connection but never answers is unreachable within timeoutMs", async () => {
    const silent = track(createTcpServer((socket) => openSockets.add(socket)));
    const url = await listen(silent);

    const started = Date.now();
    const verdict = await settleWithin(isHttpEndpointReachable(url, 300), 1500);
    const elapsed = Date.now() - started;

    expect(verdict).toBe(false);
    expect(elapsed).toBeLessThan(1500);
  });

  it("a peer that accepts then immediately closes is unreachable", async () => {
    const slam = track(createTcpServer((socket) => socket.destroy()));
    await expect(isHttpEndpointReachable(await listen(slam), 300)).resolves.toBe(false);
  });

  it("a peer that answers with non-HTTP bytes is unreachable", async () => {
    const garbage = track(
      createTcpServer((socket) => {
        openSockets.add(socket);
        socket.end("this is not http\r\n");
      }),
    );
    await expect(isHttpEndpointReachable(await listen(garbage), 300)).resolves.toBe(false);
  });

  it("timeoutMs is a deadline: a peer dripping one header byte per 100ms cannot stretch a 200ms probe to 2s", async () => {
    // 19 bytes of status line + blank line, one byte every 100ms => ~1.9s to a
    // complete response. A 200ms probe must have given up long before that.
    const statusLine = Buffer.from("HTTP/1.1 200 OK\r\n\r\n");
    const drip = track(
      createTcpServer((socket) => {
        openSockets.add(socket);
        let offset = 0;
        const timer = setInterval(() => {
          if (socket.destroyed || offset >= statusLine.length) {
            clearInterval(timer);
            return;
          }
          socket.write(statusLine.subarray(offset, offset + 1));
          offset += 1;
        }, 100);
        socket.on("close", () => clearInterval(timer));
      }),
    );
    const url = await listen(drip);

    const started = Date.now();
    const verdict = await settleWithin(isHttpEndpointReachable(url, 200), 800);
    const elapsed = Date.now() - started;

    expect(verdict).not.toBe(HUNG);
    expect(elapsed).toBeLessThan(800);
  });

  it("does not leave the probe socket open after the peer answered with a never-ending chunked body", async () => {
    let peerSocket: Socket | undefined;
    const neverEnds = track(
      createHttpServer((req, res) => {
        peerSocket = req.socket;
        openSockets.add(req.socket);
        res.writeHead(200, { "Transfer-Encoding": "chunked" });
        res.write("x");
      }),
    );
    const url = await listen(neverEnds);

    await expect(isHttpEndpointReachable(url, 200)).resolves.toBe(true);

    // The probe only needs the status line; once it has answered, the client
    // side must release the connection (the peer sees the close) rather than
    // keep an idle half-open socket alive for the rest of the process.
    expect(peerSocket).toBeDefined();
    const socket = peerSocket as Socket;
    const peerSawClose = await settleWithin(
      new Promise<true>((resolve) => {
        if (socket.destroyed) resolve(true);
        socket.once("close", () => resolve(true));
      }),
      1000,
    );
    expect(peerSawClose).toBe(true);
  });

  it.each([301, 302, 307, 308])(
    "a %i redirect to another host counts as 'up' only for the probed URL (the resolver returns the probed URL verbatim)",
    async (status) => {
      const redirect = track(
        createHttpServer((_req, res) => {
          res.writeHead(status, { Location: "http://elsewhere.invalid:9324/" });
          res.end();
        }),
      );
      const url = await listen(redirect);
      await expect(isHttpEndpointReachable(url, 300)).resolves.toBe(true);
      await expect(resolveSqsTestEndpoint({}, url)).resolves.toBe(url);
    },
  );

  it.each([429, 500, 502, 503])(
    "a %i answer still counts as a listening broker (ElasticMQ answers a bare GET with 400)",
    async (status) => {
      const busy = track(
        createHttpServer((_req, res) => {
          res.writeHead(status, { "Retry-After": "60" });
          res.end();
        }),
      );
      await expect(isHttpEndpointReachable(await listen(busy), 300)).resolves.toBe(true);
    },
  );

  it("50 concurrent probes against a silent peer all settle false, none reject, and no error escapes", async () => {
    const silent = track(createTcpServer((socket) => openSockets.add(socket)));
    const url = await listen(silent);

    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () => isHttpEndpointReachable(url, 200)),
      );
      expect(results.every((r) => r.status === "fulfilled" && r.value === false)).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUnhandled);
    }
    expect(escaped).toEqual([]);
  });
});
