// Seeds real dev Postgres + MinIO + ElasticMQ for a bounded `pnpm start` run of the media worker.
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const mode = process.argv[2]; // "seed" | "check"
const bucket = "media-audit";
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: "http://localhost:9000",
  forcePathStyle: true,
  credentials: { accessKeyId: "pickle-local", secretAccessKey: "pickle-local-secret" },
});
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const exists = async (Key) => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
    return true;
  } catch {
    return false;
  }
};
if (mode === "seed") {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
    `auth0|audit-main-${randomUUID()}`,
  ]);
  const userId = user.rows[0].id;
  const keyA = `media/${userId}/${randomUUID()}`; // master only
  const keyB = `media/${userId}/${randomUUID()}`; // master + derived
  for (const k of [keyA, keyB, `${keyB}/normalized.mp4`]) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: "x" }));
  }
  const ids = [];
  for (const k of [keyA, keyB]) {
    const r = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1,'raw_video',$2,$3,'deleted',now()) RETURNING id`,
      [userId, bucket, k],
    );
    ids.push(r.rows[0].id);
  }
  // Enqueue two purge jobs + one unhandled kind via ElasticMQ query API.
  const send = async (body) => {
    const res = await fetch("http://localhost:9324/000000000000/media-audit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Action: "SendMessage", MessageBody: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`SendMessage ${res.status} ${await res.text()}`);
  };
  await send({ kind: "media.purge", payload: { mediaId: ids[0] } });
  await send({ kind: "media.purge", payload: { mediaId: ids[1] } });
  await send({ kind: "share.render", payload: { shotId: randomUUID() } });
  console.log(JSON.stringify({ userId, keyA, keyB, ids }));
} else {
  const state = JSON.parse(process.argv[3]);
  const rows = await pool.query(
    "SELECT id, object_key, status, deleted_at IS NOT NULL AS deleted FROM media_asset WHERE id = ANY($1::uuid[]) ORDER BY id",
    [state.ids],
  );
  const out = {
    db: rows.rows,
    keyA_exists: await exists(state.keyA),
    keyB_exists: await exists(state.keyB),
    keyB_derived_exists: await exists(`${state.keyB}/normalized.mp4`),
  };
  const q = await fetch("http://localhost:9324/000000000000/media-audit", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Action: "GetQueueAttributes",
      "AttributeName.1": "ApproximateNumberOfMessages",
      "AttributeName.2": "ApproximateNumberOfMessagesNotVisible",
    }),
  });
  out.queueAttributesXml = (await q.text()).replace(/\s+/g, " ");
  console.log(JSON.stringify(out, null, 2));
}
await pool.end();
