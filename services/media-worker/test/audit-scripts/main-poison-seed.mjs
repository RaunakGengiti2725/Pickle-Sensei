// Sends malformed / missing-data jobs to the real ElasticMQ queue consumed by `pnpm start`.
import { randomUUID } from "node:crypto";
const queueUrl = "http://localhost:9324/000000000000/media-audit-poison";
const mode = process.argv[2];
const call = async (params) => {
  const res = await fetch(queueUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${params.Action} ${res.status} ${text}`);
  return text.replace(/\s+/g, " ");
};
if (mode === "seed") {
  await fetch("http://localhost:9324", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Action: "CreateQueue",
      QueueName: "media-audit-poison",
      "Attribute.1.Name": "VisibilityTimeout",
      "Attribute.1.Value": "2",
    }),
  });
  const jobs = [
    { kind: "media.purge", payload: { mediaAssetId: "not-a-uuid" } }, // pg 22P02 → throws
    { kind: "media.purge", payload: {} }, // undefined id → "not found" → acked
    { kind: "media.purge", payload: { mediaAssetId: randomUUID() } }, // unknown id → acked
    { kind: "media.process", payload: {} }, // no transcoder → claims success for nothing
    { kind: "media.process", payload: { mediaAssetId: randomUUID() } }, // unknown id → claims success
    { kind: "media.process", payload: null }, // destructuring null → throws
  ];
  for (const j of jobs) await call({ Action: "SendMessage", MessageBody: JSON.stringify(j) });
  await call({ Action: "SendMessage", MessageBody: "this is not json" }); // __malformed__
  console.log("seeded", jobs.length + 1);
} else {
  console.log(
    await call({
      Action: "GetQueueAttributes",
      "AttributeName.1": "ApproximateNumberOfMessages",
      "AttributeName.2": "ApproximateNumberOfMessagesNotVisible",
    }),
  );
}
