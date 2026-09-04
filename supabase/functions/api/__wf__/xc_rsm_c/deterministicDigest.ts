// crypto.subtle.digest() runs on a worker pool, so under concurrency the ORDER
// in which auth-cache key hashes (cache.ts authCacheKey) resolve is scheduler
// dependent — enough to change which request reaches the fake Auth first and
// make two runs of the same seed diverge. Computing the digest synchronously
// (node:crypto) and handing back an already-settled promise keeps the API and
// the bytes identical while making every interleaving a pure function of the
// seed.

import { createHash } from "node:crypto";

const realDigest = crypto.subtle.digest.bind(crypto.subtle);

let installed = false;

const NODE_ALGORITHM: Record<string, string> = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

function bytesOf(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function installDeterministicDigest(): void {
  if (installed) return;
  installed = true;
  const subtle = crypto.subtle as { digest: typeof crypto.subtle.digest };
  subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    const node = NODE_ALGORITHM[name.toUpperCase()];
    if (!node) return realDigest(algorithm, data);
    const out = createHash(node).update(bytesOf(data)).digest();
    return Promise.resolve(
      out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
    );
  }) as typeof crypto.subtle.digest;
}

export function restoreDigest(): void {
  if (!installed) return;
  (crypto.subtle as { digest: typeof crypto.subtle.digest }).digest = realDigest;
  installed = false;
}
