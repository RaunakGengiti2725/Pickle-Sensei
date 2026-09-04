import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage abstraction (spec p. 38): private bucket, short-lived signed
 * URLs, random opaque keys. Video never proxies through the API server.
 */

/** Exactly what the client is allowed to store under a presigned upload URL. */
export interface UploadConstraints {
  contentType: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the bytes the client declared. */
  sha256Hex: string;
}

/** What storage actually holds for a key (used to verify the upload). */
export interface StoredObject {
  sizeBytes: number;
  contentType: string | null;
  /** Base64 SHA-256 recorded by storage, or null when the client omitted it. */
  checksumSha256: string | null;
}

export interface IObjectStore {
  readonly bucket: string;
  presignUpload(
    key: string,
    expiresSeconds: number,
    constraints: UploadConstraints,
  ): Promise<string>;
  presignDownload(key: string, expiresSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
  /** Returns what storage holds for the key, or null when the object is absent. */
  headObject(key: string): Promise<StoredObject | null>;
}

/** Headers a client MUST send on the presigned PUT for the signature to match. */
export function uploadRequiredHeaders(constraints: UploadConstraints): Record<string, string> {
  return {
    "content-type": constraints.contentType,
    "content-length": String(constraints.sizeBytes),
    "x-amz-checksum-sha256": sha256HexToBase64(constraints.sha256Hex),
  };
}

export function sha256HexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

export interface S3StoreConfig {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle?: boolean;
}

class S3ObjectStore implements IObjectStore {
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

  async presignUpload(
    key: string,
    expiresSeconds: number,
    constraints: UploadConstraints,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: constraints.contentType,
        ContentLength: constraints.sizeBytes,
        ChecksumSHA256: sha256HexToBase64(constraints.sha256Hex),
      }),
      {
        expiresIn: expiresSeconds,
        // Binds the declared type, byte count and content hash into the
        // signature: storage itself rejects a spoofed content type, a larger
        // body, or any bytes other than the ones whose SHA-256 was declared.
        signableHeaders: new Set(["content-type", "content-length", "x-amz-checksum-sha256"]),
        // The presigner otherwise hoists x-amz-* headers into the query string,
        // where storage treats the checksum as advisory rather than signed.
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
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

  async headObject(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" }),
      );
      return {
        sizeBytes: Number(head.ContentLength ?? 0),
        contentType: head.ContentType ?? null,
        checksumSha256: head.ChecksumSHA256 ?? null,
      };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return null;
      throw error;
    }
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
