import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Socket, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Adversarial pass 3 (tester #3) — shared harness that boots the REAL
 * `src/annotate.ts` lab server (it binds at import time from process.argv),
 * in a throwaway bundles root, on a free loopback port, as a direct `node
 * --import tsx` child so /proc/<pid>/status reflects the server itself.
 *
 * Test-only file; production code is untouched.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
export const ANNOTATE_ENTRY = resolve(here, "../../src/annotate.ts");

export interface AnnotateServer {
  root: string;
  port: number;
  pid: number;
  url: (path: string) => string;
  /** Peak resident set size (VmHWM) in kB, read from /proc. */
  peakRssKb: () => number;
  /** Current resident set size (VmRSS) in kB, read from /proc. */
  rssKb: () => number;
  stdout: () => string;
  stderr: () => string;
  alive: () => boolean;
  stop: () => Promise<void>;
}

export function makeBundlesRoot(bundles: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "attack3-annotate-"));
  for (const bundle of bundles) {
    mkdirSync(join(root, bundle), { recursive: true });
    writeFileSync(join(root, bundle, "clip.mp4"), Buffer.alloc(16));
  }
  return root;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

function readProcStatus(pid: number, key: "VmHWM" | "VmRSS"): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const line = status.split("\n").find((l) => l.startsWith(`${key}:`));
  if (!line) throw new Error(`${key} not found in /proc/${pid}/status`);
  return Number(line.replace(/[^0-9]/g, ""));
}

export async function startAnnotateServer(
  bundles: string[] = ["bundle-a"],
  options: { maxOldSpaceMb?: number } = {},
): Promise<AnnotateServer> {
  const root = makeBundlesRoot(bundles);
  const port = await freePort();
  const nodeArgs = ["--import", "tsx"];
  if (options.maxOldSpaceMb !== undefined) {
    nodeArgs.push(`--max-old-space-size=${options.maxOldSpaceMb}`);
  }
  const child: ChildProcess = spawn(
    process.execPath,
    [...nodeArgs, ANNOTATE_ENTRY, root, String(port)],
    { cwd: resolve(here, "../.."), stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  while (!out.includes("annotation bench:")) {
    if (exited) {
      throw new Error(`annotate.ts exited before listening.\nstdout:\n${out}\nstderr:\n${err}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`annotate.ts did not start within 30s.\nstdout:\n${out}\nstderr:\n${err}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const pid = child.pid;
  if (pid === undefined) throw new Error("no child pid");
  return {
    root,
    port,
    pid,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    peakRssKb: () => readProcStatus(pid, "VmHWM"),
    rssKb: () => readProcStatus(pid, "VmRSS"),
    stdout: () => out,
    stderr: () => err,
    alive: () => !exited,
    stop: async () => {
      if (!exited) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((r) => child.once("exit", () => r())),
          new Promise<void>((r) => setTimeout(r, 3_000)),
        ]);
        if (!exited) child.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface RawResponse {
  status: number | null;
  body: string;
  /** True when the server closed the socket before sending a status line. */
  socketClosedEarly: boolean;
  bytesWritten: number;
}

/**
 * Streams a POST body over a raw socket so the test controls chunking,
 * content-length, and mid-flight cancellation — fetch() would buffer.
 */
export function rawPost(
  port: number,
  path: string,
  body: Buffer,
  options: { chunkSize?: number; abortAfterBytes?: number; contentLength?: number } = {},
): Promise<RawResponse> {
  const chunkSize = options.chunkSize ?? 1 << 20;
  const contentLength = options.contentLength ?? body.length;
  return new Promise((resolveResponse, reject) => {
    const socket: Socket = connect(port, "127.0.0.1");
    let received = "";
    let bytesWritten = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      const headerEnd = received.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        resolveResponse({ status: null, body: received, socketClosedEarly: true, bytesWritten });
        return;
      }
      const statusLine = received.slice(0, received.indexOf("\r\n"));
      const status = Number(statusLine.split(" ")[1]);
      const headers = received.slice(0, headerEnd).toLowerCase();
      const rawBody = received.slice(headerEnd + 4);
      const body = headers.includes("transfer-encoding: chunked") ? dechunk(rawBody) : rawBody;
      resolveResponse({ status, body, socketClosedEarly: false, bytesWritten });
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      // The server answers with content-length JSON or an empty body; finishing
      // on "end" is sufficient because annotate.ts closes idle sockets on end().
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      // ECONNRESET/EPIPE mid-upload is a legitimate "server refused the body".
      if (error.code === "ECONNRESET" || error.code === "EPIPE") {
        finish();
        return;
      }
      if (!settled) reject(error);
    });
    socket.on("connect", () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\nConnection: close\r\n\r\n`,
      );
      let offset = 0;
      const pump = (): void => {
        while (offset < body.length) {
          if (options.abortAfterBytes !== undefined && bytesWritten >= options.abortAfterBytes) {
            socket.destroy();
            finish();
            return;
          }
          if (socket.destroyed) return;
          const end = Math.min(offset + chunkSize, body.length);
          const ok = socket.write(body.subarray(offset, end));
          bytesWritten += end - offset;
          offset = end;
          if (!ok) {
            socket.once("drain", pump);
            return;
          }
        }
      };
      pump();
    });
  });
}

function dechunk(raw: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const lineEnd = raw.indexOf("\r\n", cursor);
    if (lineEnd === -1) break;
    const size = parseInt(raw.slice(cursor, lineEnd), 16);
    if (Number.isNaN(size) || size === 0) break;
    out += raw.slice(lineEnd + 2, lineEnd + 2 + size);
    cursor = lineEnd + 2 + size + 2;
  }
  return out;
}

export function minimalAnnotation(
  captureBundle: string,
  annotatorId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    captureBundle,
    annotatorId,
    createdAtIso: "2026-09-04T00:00:00.000Z",
    revision: 0,
    stroke: "dink",
    handedness: "right",
    analyzable: true,
    notAnalyzableReason: null,
    phases: {
      preparationStartMs: null,
      accelerationStartMs: null,
      contactMs: null,
      followThroughEndMs: null,
    },
    faults: [],
    checkpointScores: {},
    overallScore: null,
    annotatorConfidence: 0.5,
    notes: "",
    history: [],
    ...extra,
  };
}
