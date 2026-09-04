import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Real S3-protocol harness against the local MinIO from docker-compose
 * (`docker compose up -d minio`). Gated on S3_ENDPOINT_TEST (e.g.
 * http://localhost:9000) the same way the SQS tests gate on
 * SQS_ENDPOINT_TEST; credentials default to the compose values and can be
 * overridden with S3_ACCESS_KEY_ID_TEST / S3_SECRET_ACCESS_KEY_TEST.
 */

export const minioEndpoint = process.env["S3_ENDPOINT_TEST"] ?? "";
export const minioRegion = "us-east-1";
export const minioAccessKeyId = process.env["S3_ACCESS_KEY_ID_TEST"] ?? "pickle-local";
export const minioSecretAccessKey =
  process.env["S3_SECRET_ACCESS_KEY_TEST"] ?? "pickle-local-secret";

/** Env shape `buildObjectDeleter` / `buildObjectStore` read, pointed at MinIO. */
export function minioEnv(bucket: string): NodeJS.ProcessEnv {
  return {
    S3_MEDIA_BUCKET: bucket,
    S3_ENDPOINT: minioEndpoint,
    AWS_REGION: minioRegion,
    S3_ACCESS_KEY_ID: minioAccessKeyId,
    S3_SECRET_ACCESS_KEY: minioSecretAccessKey,
  };
}

export function minioClient(): S3Client {
  return new S3Client({
    region: minioRegion,
    endpoint: minioEndpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minioAccessKeyId, secretAccessKey: minioSecretAccessKey },
  });
}

export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
  }
}

export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array | string = "x",
): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

export async function objectExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") return false;
    throw error;
  }
}

/** Independent ground-truth listing (own pagination) to compare the SUT against. */
export async function listAllKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Bulk PUT with bounded concurrency (MinIO handles ~64 in flight comfortably). */
export async function putMany(
  client: S3Client,
  bucket: string,
  keys: readonly string[],
  concurrency = 32,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++]!;
      await putObject(client, bucket, key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
}

export async function deleteAllUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<void> {
  const keys = await listAllKeys(client, bucket, prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}
