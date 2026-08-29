import {
  sha256HexToBase64,
  type IObjectStore,
  type StoredObject,
  type UploadConstraints,
} from "../../src/modules/media/objectStore.js";

/**
 * Synthetic in-memory object store. Byte sizes are set per key by tests; the
 * stored content type and checksum default to what the presigned URL bound
 * (an honest upload) and can be overridden to simulate a spoofing client that
 * stored bytes other than the ones it declared.
 */
export class FakeObjectStore implements IObjectStore {
  readonly bucket = "fake-bucket";
  objects = new Map<string, number>();
  deletedKeys: string[] = [];
  signed = new Map<string, UploadConstraints>();
  storedContentType = new Map<string, string | null>();
  storedChecksum = new Map<string, string | null>();

  async presignUpload(
    key: string,
    expiresSeconds: number,
    constraints: UploadConstraints,
  ): Promise<string> {
    this.signed.set(key, constraints);
    return `https://fake/upload/${key}?expires=${expiresSeconds}`;
  }

  async presignDownload(key: string): Promise<string> {
    return `https://fake/download/${key}`;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }

  async headObject(key: string): Promise<StoredObject | null> {
    const size = this.objects.get(key);
    if (size === undefined) return null;
    const constraints = this.signed.get(key);
    return {
      sizeBytes: size,
      contentType: this.storedContentType.has(key)
        ? this.storedContentType.get(key)!
        : (constraints?.contentType ?? null),
      checksumSha256: this.storedChecksum.has(key)
        ? this.storedChecksum.get(key)!
        : constraints
          ? sha256HexToBase64(constraints.sha256Hex)
          : null,
    };
  }
}
