import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";

/**
 * Adversarial pass 3 (storage-media-worker #4) — Scenario 4.
 *
 * Runs the REAL entrypoint (src/main.ts via tsx) as a child process against
 * ElasticMQ through a controllable TCP proxy. Mid-test the proxy goes dark
 * (connection refused + live sockets destroyed) so `SqsJobQueue.receive()`
 * rejects exactly as it would if ElasticMQ/SQS were stopped. Asserted
 * main.ts semantics:
 *   - the process does not exit; each failed cycle logs `poll cycle failed`
 *     and emits (and flushes) a `worker_crash` analytics event with a
 *     monotonically growing crashCount;
 *   - deletion tasks are NOT processed during a failed cycle (receive() is
 *     the first await in runOnce, so processDeletionTasks never runs);
 *   - polling resumes on the next interval once the queue is reachable and
 *     the deletion task then completes.
 *
 * Gated on DATABASE_URL_TEST + SQS_ENDPOINT_TEST like the other integration
 * suites. Uses its own isolated schema so it can share the physical test DB.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const sqsEndpoint = process.env["SQS_ENDPOINT_TEST"];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "packages", "database", "migrations");
const schemaName = `attack_smw4_main_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

async function sqsQuery(url: string, params: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.text();
  if (res.status !== 200) throw new Error(`${params["Action"]} failed: ${res.status} ${body}`);
  return body;
}

/** TCP proxy in front of ElasticMQ that can be switched off (refuses + kills). */
class OutageProxy {
  private server = net.createServer((client) => this.onConnection(client));
  private sockets = new Set<net.Socket>();
  online = true;
  port = 0;
  refused = 0;

  constructor(
    private upstreamHost: string,
    private upstreamPort: number,
  ) {}

  private onConnection(client: net.Socket): void {
    if (!this.online) {
      this.refused++;
      client.destroy();
      return;
    }
    const upstream = net.connect(this.upstreamPort, this.upstreamHost);
    this.sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  goDark(): void {
    this.online = false;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  restore(): void {
    this.online = true;
  }

  async stop(): Promise<void> {
    this.goDark();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

interface WorkerLog {
  lines: string[];
  crashes: () => number[];
  analytics: () => Array<Record<string, unknown>>;
  processed: () => string[];
  waitFor: (pred: (lines: string[]) => boolean, timeoutMs: number, label: string) => Promise<void>;
}

function attachLog(child: ChildProcessWithoutNullStreams): WorkerLog {
  const lines: string[] = [];
  let partial = "";
  const onChunk = (chunk: Buffer) => {
    partial += chunk.toString("utf8");
    const parts = partial.split("\n");
    partial = parts.pop() ?? "";
    lines.push(...parts);
  };
  child.stderr.on("data", onChunk);
  child.stdout.on("data", onChunk);
  return {
    lines,
    crashes: () =>
      lines
        .map((l) => /poll cycle failed \(crash (\d+)\)/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1])),
    analytics: () =>
      lines
        .filter((l) => l.startsWith("[media-worker] analytics "))
        .map(
          (l) => JSON.parse(l.slice("[media-worker] analytics ".length)) as Record<string, unknown>,
        ),
    processed: () => lines.filter((l) => l.startsWith("[media-worker] processed ")),
    waitFor: async (pred, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred(lines)) return;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${label}; log so far:\n${lines.join("\n")}`);
    },
  };
}

describe.skipIf(!testUrl || !sqsEndpoint)(
  "attack pass 3: main.ts under a mid-run queue outage (real entrypoint, real ElasticMQ via proxy)",
  () => {
    let adminPool: pg.Pool;
    let pool: pg.Pool;
    let userId: string;
    let proxy: OutageProxy;
    let queueUrl: string;
    let child: ChildProcessWithoutNullStreams | null = null;

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
      await runMigrations(pool, migrationsDir);
      await seed(pool);
      const user = await pool.query(
        "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
        [`auth0|attack-smw4-main-${randomUUID()}`],
      );
      userId = user.rows[0].id as string;

      const upstream = new URL(sqsEndpoint!);
      proxy = new OutageProxy(upstream.hostname, Number(upstream.port || 80));
      await proxy.start();

      const created = await sqsQuery(sqsEndpoint!, {
        Action: "CreateQueue",
        QueueName: `attack-s4-${Date.now()}`,
        "Attribute.1.Name": "VisibilityTimeout",
        "Attribute.1.Value": "2",
      });
      queueUrl = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(created)![1]!;
    }, 60_000);

    afterAll(async () => {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await proxy?.stop();
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    });

    async function sendPurgeForMissingAsset(): Promise<void> {
      // handled:true ("media_asset … not found") → acked → "processed jobs=1".
      await sqsQuery(sqsEndpoint!, {
        Action: "SendMessage",
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          kind: "media.purge",
          payload: { mediaAssetId: randomUUID() },
        }),
      });
    }

    async function taskStatus(taskId: string): Promise<{ status: string; attempts: number }> {
      const r = await pool.query("SELECT status, attempts FROM deletion_task WHERE id = $1", [
        taskId,
      ]);
      return r.rows[0] as { status: string; attempts: number };
    }

    it("S4: queue receive() rejects mid-run → worker_crash per cycle, deletion tasks untouched that cycle, polling resumes and drains once the queue is back", async () => {
      const tsxBin = join(here, "..", "node_modules", ".bin", "tsx");
      const env: NodeJS.ProcessEnv = {
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        DATABASE_URL: schemaUrl(testUrl!, schemaName),
        SQS_QUEUE_URL: queueUrl,
        SQS_ENDPOINT: `http://127.0.0.1:${proxy.port}`,
        AWS_REGION: "us-west-2",
        AWS_ACCESS_KEY_ID: "x",
        AWS_SECRET_ACCESS_KEY: "x",
        WORKER_INTERVAL_MS: "300",
        // No S3_MEDIA_BUCKET on purpose: objectStore=null. social_cleanup does
        // not need it, so it is the deletion task we watch.
      };
      child = spawn(tsxBin, ["src/main.ts"], { cwd: join(here, ".."), env, stdio: "pipe" });
      const log = attachLog(child);

      // ---- Phase A: healthy. worker_started flushed; a job gets processed.
      await log.waitFor(
        (l) => l.some((x) => x.includes("polling every 300ms")),
        20_000,
        "startup banner",
      );
      await sendPurgeForMissingAsset();
      await log.waitFor(
        (l) => l.some((x) => x.includes("processed jobs=1")),
        20_000,
        "healthy cycle",
      );
      const healthyNames = log.analytics().map((e) => e["name"]);
      expect(healthyNames[0]).toBe("worker_started");
      expect(healthyNames).toContain("queue_backlog");
      expect(healthyNames).not.toContain("worker_crash");
      expect(log.crashes()).toEqual([]);

      // ---- Phase B: outage. Queue unreachable; a deletion task is seeded
      // while the queue is down. It must NOT be processed during failed cycles.
      proxy.goDark();
      const task = await pool.query(
        "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1, 'social_cleanup', 'queued') RETURNING id",
        [userId],
      );
      const taskId = task.rows[0].id as string;
      const outageStart = Date.now();
      await log.waitFor(
        (l) => l.some((x) => x.includes("poll cycle failed (crash 3)")),
        60_000,
        "3 crash cycles",
      );
      const outageMs = Date.now() - outageStart;
      expect(proxy.refused).toBeGreaterThan(0);
      expect(await taskStatus(taskId)).toEqual({ status: "queued", attempts: 0 });
      expect(child.exitCode).toBeNull();

      const crashSeq = log.crashes();
      expect(crashSeq.slice(0, 3)).toEqual([1, 2, 3]); // monotonic, one per cycle
      const crashEvents = log.analytics().filter((e) => e["name"] === "worker_crash");
      expect(crashEvents.length).toBeGreaterThanOrEqual(3);
      expect(crashEvents.slice(0, 3).map((e) => e["crashCount"])).toEqual([1, 2, 3]);
      for (const e of crashEvents) expect(e["platform"]).toBe("service");
      // The failure text names the SDK error, never a secret.
      const failLine = log.lines.find((l) => l.includes("poll cycle failed (crash 1)"))!;
      expect(failLine).toMatch(/ECONNREFUSED|ECONNRESET|socket hang up|EPIPE|aborted/i);
      expect(failLine).not.toContain("AWS_SECRET");

      // ---- Phase C: recovery. Polling resumes; the task drains; new job handled.
      proxy.restore();
      await sendPurgeForMissingAsset();
      await log.waitFor(
        (l) => l.filter((x) => x.includes("processed jobs=1")).length >= 2,
        30_000,
        "post-recovery job",
      );
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await taskStatus(taskId)).status !== "done")
        await sleep(100);
      expect(await taskStatus(taskId)).toEqual({ status: "done", attempts: 0 });
      const crashesAfterRecovery = log.crashes().length;
      await sleep(1000); // a few more healthy intervals
      expect(log.crashes().length).toBe(crashesAfterRecovery); // no crash after recovery
      expect(child.exitCode).toBeNull();

      // crashCount is process-lifetime monotonic: it does NOT reset on recovery.
      // A second outage continues the sequence (alerting sees n+1, not 1).
      proxy.goDark();
      await log.waitFor(
        (l) =>
          l.filter((x) => /poll cycle failed \(crash \d+\)/.test(x)).length > crashesAfterRecovery,
        30_000,
        "second outage crash",
      );
      const seq = log.crashes();
      expect(seq[seq.length - 1]).toBe(crashesAfterRecovery + 1);
      proxy.restore();

      child.kill("SIGTERM");
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && child.exitCode === null && child.signalCode === null)
        await sleep(50);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

      console.error(
        `[S4] outage of ${outageMs}ms → crashes=${JSON.stringify(seq)} refusedConnections=${proxy.refused} lines=${log.lines.length}\n[S4] child log:\n${log.lines.join("\n")}`,
      );
    }, 120_000);
  },
);
