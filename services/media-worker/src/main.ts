import pg from "pg";
import { InMemoryJobQueue, SqsJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "./worker.js";
import { buildObjectDeleter } from "./objectStore.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL required");
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
  const { jobs, deletions, swept } = await runOnce(deps);
  if (jobs || deletions || swept)
    console.error(`[media-worker] processed jobs=${jobs} deletions=${deletions} swept=${swept}`);
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
