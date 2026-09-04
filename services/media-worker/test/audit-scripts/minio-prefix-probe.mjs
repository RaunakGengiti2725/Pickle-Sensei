// Probe: does an S3-compatible store list `x/child` under prefix `x/` while an object named `x` exists?
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT_TEST ?? "http://localhost:9000";
const s3 = new S3Client({
  region: "us-east-1",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: "pickle-local", secretAccessKey: "pickle-local-secret" },
});
const Bucket = `probe-${Date.now()}`;
await s3.send(new CreateBucketCommand({ Bucket }));
const master = "media/master";
const list = async (Prefix) =>
  ((await s3.send(new ListObjectsV2Command({ Bucket, Prefix }))).Contents ?? []).map((o) => o.Key);
const head = async (Key) => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key }));
    return true;
  } catch (e) {
    return `${e.name}`;
  }
};
const out = {};
await s3.send(new PutObjectCommand({ Bucket, Key: master, Body: "m" }));
out.putMaster = "ok";
try {
  await s3.send(new PutObjectCommand({ Bucket, Key: `${master}/normalized.mp4`, Body: "n" }));
  out.putDerivedWhileMasterExists = "ok";
} catch (e) {
  out.putDerivedWhileMasterExists = `${e.name}: ${e.message}`;
}
out.headMaster = await head(master);
out.headDerived = await head(`${master}/normalized.mp4`);
out.listPrefixMasterSlash_whileMasterExists = await list(`${master}/`);
out.listPrefixMaster_whileMasterExists = await list(master);
await s3.send(new DeleteObjectCommand({ Bucket, Key: master }));
out.headMasterAfterDelete = await head(master);
out.headDerivedAfterMasterDelete = await head(`${master}/normalized.mp4`);
out.listPrefixMasterSlash_afterMasterDelete = await list(`${master}/`);
// Reverse order: derived first, then master.
const m2 = "media/master2";
await s3.send(new PutObjectCommand({ Bucket, Key: `${m2}/thumb.jpg`, Body: "t" }));
try {
  await s3.send(new PutObjectCommand({ Bucket, Key: m2, Body: "m" }));
  out.putMasterWhileDerivedExists = "ok";
} catch (e) {
  out.putMasterWhileDerivedExists = `${e.name}: ${e.message}`;
}
out.headMaster2 = await head(m2);
out.headDerived2 = await head(`${m2}/thumb.jpg`);
out.listPrefixMaster2Slash = await list(`${m2}/`);
console.log(JSON.stringify(out, null, 2));
