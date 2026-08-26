import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage abstraction (spec p. 38): private bucket, short-lived signed
 * URLs, random opaque keys. Video never proxies through the API server.
 */

export interface IObjectStore {
  readonly bucket: string;
  presignUpload(key: string, contentType: string, expiresSeconds: number): Promise<string>;
  presignDownload(key: string, expiresSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export interface S3StoreConfig {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle?: boolean;
}

export class S3ObjectStore implements IObjectStore {
  readonly bucket: string;
  private client: S3Client;

  constructor(config: S3StoreConfig) {
    this.bucket = config.bucket;
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

  async presignUpload(key: string, contentType: string, expiresSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresSeconds },
    );
  }

  async presignDownload(key: string, expiresSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresSeconds,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function buildObjectStore(env: NodeJS.ProcessEnv): IObjectStore | null {
  const bucket = env["S3_MEDIA_BUCKET"];
  if (!bucket) return null;
  return new S3ObjectStore({
    bucket,
    region: env["AWS_REGION"] ?? "us-west-2",
    endpoint: env["S3_ENDPOINT"],
    accessKeyId: env["S3_ACCESS_KEY_ID"],
    secretAccessKey: env["S3_SECRET_ACCESS_KEY"],
  });
}
