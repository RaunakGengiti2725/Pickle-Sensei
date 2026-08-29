import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import type { ObjectDeleter } from "./worker.js";

/**
 * Storage deleter for the purge and account-deletion paths. Without it the
 * worker refuses to claim a purge (see worker.ts), so erasure would stall
 * forever: the deployed entrypoint must build it from configuration.
 */

class S3ObjectDeleter implements ObjectDeleter {
  private client: S3Client;

  constructor(
    private bucket: string,
    config: {
      region: string;
      endpoint?: string | undefined;
      accessKeyId?: string | undefined;
      secretAccessKey?: string | undefined;
    },
  ) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }
}

export function buildObjectDeleter(env: NodeJS.ProcessEnv): ObjectDeleter | null {
  const bucket = env["S3_MEDIA_BUCKET"];
  if (!bucket) return null;
  return new S3ObjectDeleter(bucket, {
    region: env["AWS_REGION"] ?? "us-west-2",
    endpoint: env["S3_ENDPOINT"],
    accessKeyId: env["S3_ACCESS_KEY_ID"],
    secretAccessKey: env["S3_SECRET_ACCESS_KEY"],
  });
}
