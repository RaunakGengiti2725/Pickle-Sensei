import { spawn, type ChildProcess } from "node:child_process";
import { once, type EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { envInt, sleep } from "./faultKit.js";

/**
 * Process-level failure injection for services/media-worker/src/main.ts: the
 * real entrypoint is spawned with `tsx` against (a) no database URL, (b) a
 * closed port, (c) a TCP black hole that never completes the Postgres
 * handshake, and (d) malformed WORKER_INTERVAL_MS values. Only stderr lines
 * are read; nothing here touches a real database.
 */

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");

interface Run {
  child: ChildProcess;
  lines: string[];
  exit: Promise<number | null>;
}

function start(env: Record<string, string>): Run {
  const child: ChildProcess = spawn(tsxBin, ["src/main.ts"], {
    cwd: pkgRoot,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const lines: string[] = [];
  let buffer = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts);
  });
  // @types/node 26 declares ChildProcess's emitter surface via interface
  // merging that this tsconfig does not resolve; the runtime object is an
  // EventEmitter.
  const exit = once(child as unknown as EventEmitter, "exit").then(
    ([code]) => code as number | null,
  );
  return { child, lines, exit };
}

async function blackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function closedPort(): Promise<number> {
  const hole = await blackHole();
  await hole.close();
  return hole.port;
}

async function waitFor(run: Run, predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

/** How long to wait for a hung DB handshake to surface (60 s for evidence runs). */
const HANG_WAIT_MS = envInt("STRESS_HANG_WAIT_MS", 8_000);

const crashLines = (run: Run) => run.lines.filter((l) => l.includes("poll cycle failed (crash"));
const crashEvents = (run: Run) => run.lines.filter((l) => l.includes('"name":"worker_crash"'));

describe("media worker entrypoint under dependency failure (spawned process)", () => {
  const running: Run[] = [];
  afterEach(async () => {
    for (const run of running.splice(0)) {
      run.child.kill("SIGKILL");
      await run.exit;
    }
  });

  it("refuses to start without a database URL (exit 1, explicit message)", async () => {
    const run = start({});
    running.push(run);
    const code = await Promise.race([run.exit, sleep(15_000).then(() => "timeout" as const)]);
    expect(code).toBe(1);
    expect(run.lines.join("\n")).toContain("DATABASE_URL_WORKER or DATABASE_URL required");
  }, 20_000);

  it("a refused database keeps the process alive and logs every crashed cycle + worker_crash", async () => {
    const port = await closedPort();
    const run = start({
      DATABASE_URL: `postgres://u:p@127.0.0.1:${port}/db`,
      WORKER_INTERVAL_MS: "100",
    });
    running.push(run);
    expect(await waitFor(run, () => crashLines(run).length >= 3, 15_000)).toBe(true);
    expect(run.child.exitCode).toBeNull();
    expect(run.lines.some((l) => l.includes('"name":"worker_started"'))).toBe(true);
    expect(crashEvents(run).length).toBeGreaterThanOrEqual(3);
    // Crash counter is monotonic and no cycle claims progress.
    const counts = crashLines(run).map((l) => Number(/crash (\d+)\)/.exec(l)?.[1]));
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(run.lines.some((l) => l.includes("processed jobs="))).toBe(false);
    // Error text stays operational: no credentials leak into logs.
    expect(run.lines.join("\n")).not.toContain("u:p@");
  }, 20_000);

  it.fails(
    `a database that accepts TCP but never answers must surface as a crashed cycle within ${HANG_WAIT_MS} ms`,
    async () => {
      const hole = await blackHole();
      try {
        const run = start({
          DATABASE_URL: `postgres://u:p@127.0.0.1:${hole.port}/db`,
          WORKER_INTERVAL_MS: "100",
        });
        running.push(run);
        expect(
          await waitFor(run, () => run.lines.some((l) => l.includes("polling every")), 15_000),
        ).toBe(true);
        // pg.Pool is built without connectionTimeoutMillis / statement_timeout
        // and main.ts has no per-cycle watchdog: the first cycle never
        // settles, so no crash is logged and no worker_crash is tracked. The
        // only external signal is the absence of `worker_started` re-emits.
        const surfaced = await waitFor(run, () => crashLines(run).length >= 1, HANG_WAIT_MS);
        expect(surfaced, `no crash logged; lines=${JSON.stringify(run.lines.slice(-3))}`).toBe(
          true,
        );
      } finally {
        await hole.close();
      }
    },
    HANG_WAIT_MS + 30_000,
  );

  for (const bad of ["abc", "-5", ""]) {
    it.fails(
      `WORKER_INTERVAL_MS=${JSON.stringify(bad)} must not turn the poll loop into a hot loop`,
      async () => {
        const port = await closedPort();
        const run = start({
          DATABASE_URL: `postgres://u:p@127.0.0.1:${port}/db`,
          WORKER_INTERVAL_MS: bad,
        });
        running.push(run);
        expect(
          await waitFor(run, () => run.lines.some((l) => l.includes("polling every")), 15_000),
        ).toBe(true);
        await sleep(1500);
        // Number("abc") is NaN, Number("") is 0, "-5" is negative — all make
        // setTimeout fire immediately, so a DB outage becomes a tight retry
        // loop against the failing dependency. EXPECTED: reject or fall back
        // to the 5000 ms default (≤ 1 crash in 1.5 s).
        const crashes = crashLines(run).length;
        // Surfaced in the vitest output so evidence runs can quote the rate.
        console.warn(
          `[stress] WORKER_INTERVAL_MS=${JSON.stringify(bad)} → ${crashes} crashed cycles in 1.5 s`,
        );
        expect(crashes, `crashes in 1.5s: ${crashes}`).toBeLessThanOrEqual(1);
      },
      20_000,
    );
  }
});
