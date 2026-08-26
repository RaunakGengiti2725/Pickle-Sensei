import pg from "pg";
import { InMemoryJobQueue, SqsJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "./worker.js";

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
  objectStore: null, // wired to S3ObjectStore in deployment
  transcoder: null, // ffmpeg pipeline wired in deployment image
  log: (line) => console.error(`[media-worker] ${line}`),
};

const intervalMs = Number(process.env["WORKER_INTERVAL_MS"] ?? 5000);
console.error(`[media-worker] polling every ${intervalMs}ms`);

while (true) {
  const { jobs, deletions } = await runOnce(deps);
  if (jobs || deletions)
    console.error(`[media-worker] processed jobs=${jobs} deletions=${deletions}`);
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
