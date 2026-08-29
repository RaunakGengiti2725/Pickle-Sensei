import pg from "pg";
import { InMemoryJobQueue, SqsJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "./worker.js";
import { buildObjectDeleter } from "./objectStore.js";

// Worker runtime role (DATABASE_URL_WORKER) with DATABASE_URL fallback for
// single-credential local setups; migrations use owner credentials via the
// @pickle/database CLI.
const databaseUrl = process.env["DATABASE_URL_WORKER"] ?? process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL_WORKER or DATABASE_URL required");
  process.exit(1);
}
const sqsUrl = process.env["SQS_QUEUE_URL"];
const deps: WorkerDeps = {
  pool: new pg.Pool({ connectionString: databaseUrl }),
  queue: sqsUrl
    ? new SqsJobQueue({
        queueUrl: sqsUrl,
        region: process.env["AWS_REGION"] ?? "us-west-2",
        ...(process.env["SQS_ENDPOINT"] ? { endpoint: process.env["SQS_ENDPOINT"] } : {}),
      })
    : new InMemoryJobQueue(),
  // Built from configuration: without it purge and account deletion stall
  // (the worker refuses to claim an erasure it cannot perform).
  objectStore: buildObjectDeleter(process.env),
  transcoder: null, // ffmpeg pipeline wired in deployment image
  log: (line) => console.error(`[media-worker] ${line}`),
};

const intervalMs = Number(process.env["WORKER_INTERVAL_MS"] ?? 5000);
console.error(`[media-worker] polling every ${intervalMs}ms`);

while (true) {
  // A transient failure (DB outage, queue unreachable) must not crash the
  // worker process: log loudly and keep polling.
  try {
    const { jobs, deletions, swept } = await runOnce(deps);
    if (jobs || deletions || swept)
      console.error(`[media-worker] processed jobs=${jobs} deletions=${deletions} swept=${swept}`);
  } catch (error) {
    console.error(`[media-worker] poll cycle failed: ${String(error)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
