import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { GetObjectTaggingCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  buildObjectStore,
  sha256HexToBase64,
  uploadRequiredHeaders,
  type IObjectStore,
  type UploadConstraints,
} from "../../src/modules/media/objectStore.js";

/**
 * Adversarial harness for the S3-compatible media bucket + presigned URLs the
 * legacy API (services/api) issues. Every request is a RAW HTTP request built
 * from the presigned URL — no SDK signing on the attacker side — against a
 * REAL S3-compatible endpoint (MinIO locally), through the production
 * `buildObjectStore()` code path. The harness never asserts; it records what
 * storage answered per case and what the API's `complete()` gate would have
 * decided from `headObject()`, so the JSON matrix is the evidence.
 *
 * Deterministic: every randomized input derives from the run seed
 * (mulberry32), and each case records its own derived seed for replay.
 */

export interface HarnessEnv {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function harnessEnvFromProcess(env: NodeJS.ProcessEnv): HarnessEnv | null {
  const endpoint = env["S3_TEST_ENDPOINT"];
  const accessKeyId = env["S3_TEST_ACCESS_KEY_ID"];
  const secretAccessKey = env["S3_TEST_SECRET_ACCESS_KEY"];
  const bucket = env["S3_TEST_BUCKET"];
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    endpoint,
    region: env["S3_TEST_REGION"] ?? "us-west-2",
    accessKeyId,
    secretAccessKey,
    bucket,
  };
}

/** The store exactly as production builds it, fed from the harness env. */
export function buildHarnessStore(env: HarnessEnv): IObjectStore {
  const store = buildObjectStore({
    S3_MEDIA_BUCKET: env.bucket,
    AWS_REGION: env.region,
    S3_ENDPOINT: env.endpoint,
    S3_ACCESS_KEY_ID: env.accessKeyId,
    S3_SECRET_ACCESS_KEY: env.secretAccessKey,
  });
  if (!store) throw new Error("buildObjectStore returned null for a fully specified env");
  return store;
}

/** Privileged client used ONLY for setup/inspection (bucket create, tags, listing). */
export function adminClient(env: HarnessEnv): S3Client {
  return new S3Client({
    region: env.region,
    endpoint: env.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
}

/** mulberry32 — small, seedable, good enough for replayable fuzz inputs. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function seededBytes(rng: () => number, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const value = items[Math.floor(rng() * items.length)];
  if (value === undefined) throw new Error("pick from empty list");
  return value;
}

export interface RawResponse {
  status: number;
  /** S3 error code parsed from the XML body, or null when absent. */
  code: string | null;
  bodyPrefix: string;
  bodyBytes: number;
}

/** Raw HTTP request; nothing is signed here, the URL/headers are sent as given. */
export function rawRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  payload?: Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers,
        // One connection per request: the server closes the socket after some
        // error responses and a reused keep-alive socket would surface as a
        // client-side hang-up instead of the server's real answer.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const text = body.toString("utf8");
          const match = /<Code>([^<]+)<\/Code>/.exec(text);
          resolve({
            status: res.statusCode ?? 0,
            code: match?.[1] ?? null,
            bodyPrefix: text.slice(0, 160),
            bodyBytes: body.length,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Rewrites the object key segment of a path-style presigned URL, keeping the query (signature) intact. */
export function substituteKey(url: string, bucket: string, newKey: string): string {
  const target = new URL(url);
  const prefix = `/${bucket}/`;
  if (!target.pathname.startsWith(prefix)) {
    throw new Error(`presigned URL is not path-style for bucket ${bucket}: ${target.pathname}`);
  }
  // Keep `..` and other traversal sequences verbatim: the point is to see
  // what the server does with them, so bypass URL normalization.
  const encodedKey = newKey
    .split("/")
    .map((segment) => (segment === ".." || segment === "." ? segment : encodeURIComponent(segment)))
    .join("/");
  return `${target.origin}${prefix}${encodedKey}${target.search}`;
}

export function setQueryParam(url: string, name: string, value: string): string {
  const target = new URL(url);
  target.searchParams.set(name, value);
  return target.toString();
}

export function flipSignatureNibble(url: string, rng: () => number): string {
  const target = new URL(url);
  const signature = target.searchParams.get("X-Amz-Signature");
  if (!signature) throw new Error("presigned URL carries no X-Amz-Signature");
  const index = randomInt(rng, 0, signature.length - 1);
  const current = signature[index] ?? "0";
  const replacement = current === "0" ? "1" : "0";
  target.searchParams.set(
    "X-Amz-Signature",
    `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`,
  );
  return target.toString();
}

export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime"] as const;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/webp"] as const;

/** What the API's POST /v1/media/:id/complete gate would decide for the stored object. */
export type CompleteDecision =
  | "accept"
  | "reject:object_missing"
  | "reject:size_exceeded"
  | "reject:content_type_mismatch"
  | "reject:checksum_mismatch";

export async function completeDecision(
  store: IObjectStore,
  key: string,
  declared: UploadConstraints,
  maxUploadBytes: number,
): Promise<CompleteDecision> {
  const head = await store.headObject(key);
  if (!head) return "reject:object_missing";
  if (head.sizeBytes > declared.sizeBytes || head.sizeBytes > maxUploadBytes) {
    return "reject:size_exceeded";
  }
  if (head.contentType !== null && head.contentType !== declared.contentType) {
    return "reject:content_type_mismatch";
  }
  if (head.checksumSha256 !== sha256HexToBase64(declared.sha256Hex)) {
    return "reject:checksum_mismatch";
  }
  return "accept";
}

export interface CaseResult {
  id: string;
  family: string;
  /** Per-case derived seed; re-run with `--seed <runSeed>` and look the id up. */
  caseSeed: number;
  input: Record<string, unknown>;
  /** Raw storage answer for the adversarial request (null when no request was made). */
  storage: RawResponse | null;
  /** `complete()` decision for the target key after the request (null when n/a). */
  completeDecision: CompleteDecision | null;
  /** Whether the object under the target key changed/appeared as a result of the attack. */
  objectAffected: boolean | null;
  expected: string;
  pass: boolean;
  note?: string;
}

export interface MatrixSummary {
  runSeed: number;
  casesPerFamily: number;
  endpoint: string;
  bucket: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  byFamily: Record<string, { total: number; passed: number; failed: number }>;
}

export interface MatrixRun {
  summary: MatrixSummary;
  results: CaseResult[];
}

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

interface Declared {
  userId: string;
  key: string;
  body: Buffer;
  constraints: UploadConstraints;
}

function declare(rng: () => number, kind: "raw_video" | "thumbnail"): Declared {
  const size = randomInt(rng, 1, 64 * 1024);
  const body = seededBytes(rng, size);
  const userId = `${seededBytes(rng, 8).toString("hex")}-user`;
  const key = `media/${userId}/${seededBytes(rng, 24).toString("hex")}`;
  const contentType =
    kind === "raw_video" ? pick(rng, ALLOWED_VIDEO_TYPES) : pick(rng, ALLOWED_IMAGE_TYPES);
  return {
    userId,
    key,
    body,
    constraints: {
      contentType,
      sizeBytes: body.length,
      sha256Hex: createHash("sha256").update(body).digest("hex"),
    },
  };
}

function headersFor(constraints: UploadConstraints, overrides: Record<string, string | null>) {
  const headers: Record<string, string> = { ...uploadRequiredHeaders(constraints) };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return headers;
}

async function objectExists(store: IObjectStore, key: string): Promise<boolean> {
  return (await store.headObject(key)) !== null;
}

/**
 * HEAD for keys the server may refuse outright (e.g. literal `..` segments):
 * a refused HEAD means no object is addressable under that key.
 */
async function literalKeyAddressable(
  store: IObjectStore,
  key: string,
): Promise<{ exists: boolean; error: string | null }> {
  try {
    return { exists: (await store.headObject(key)) !== null, error: null };
  } catch (error) {
    return { exists: false, error: (error as { name?: string }).name ?? "Error" };
  }
}

type CaseRunner = (
  rng: () => number,
  index: number,
) => Promise<Omit<CaseResult, "id" | "family" | "caseSeed">>;

async function honestUpload(store: IObjectStore, d: Declared): Promise<RawResponse> {
  const url = await store.presignUpload(d.key, 900, d.constraints);
  return rawRequest("PUT", url, headersFor(d.constraints, {}), d.body);
}

/**
 * Families. Each returns the raw storage response, the complete() decision
 * for the TARGET key and the pass verdict against the documented contract:
 *   - storage-layer binding: key, bucket, method, expiry, signature, signed
 *     headers (content-type, content-length) → storage must refuse (403/400)
 *   - byte binding: the API's complete() gate must refuse any stored object
 *     whose bytes differ from the declared SHA-256 (storage MAY accept the PUT)
 *   - anonymous access: every unsigned verb must be refused
 */
export function buildFamilies(store: IObjectStore, env: HarnessEnv): Record<string, CaseRunner> {
  const admin = adminClient(env);
  const otherKind = (kind: "raw_video" | "thumbnail") =>
    kind === "raw_video" ? "thumbnail" : "raw_video";

  return {
    "upload.honest": async (rng) => {
      const d = declare(rng, pick(rng, ["raw_video", "thumbnail"] as const));
      const storage = await honestUpload(store, d);
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, size: d.body.length, contentType: d.constraints.contentType },
        storage,
        completeDecision: decision,
        objectAffected: true,
        expected: "storage 200 + complete accept",
        pass: storage.status === 200 && decision === "accept",
      };
    },

    "upload.bytes_swapped_no_checksum_header": async (rng) => {
      const d = declare(rng, "raw_video");
      const other = seededBytes(rng, d.body.length);
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const storage = await rawRequest(
        "PUT",
        url,
        headersFor(d.constraints, { "x-amz-checksum-sha256": null }),
        other,
      );
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, size: d.body.length, declaredSha256: d.constraints.sha256Hex },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "complete rejects (checksum_mismatch or object_missing)",
        pass: decision === "reject:checksum_mismatch" || decision === "reject:object_missing",
        note: "storage acceptance of the PUT is recorded, not asserted: byte binding lives in complete()",
      };
    },

    "upload.bytes_swapped_with_own_checksum": async (rng) => {
      const d = declare(rng, "raw_video");
      const other = seededBytes(rng, d.body.length);
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const storage = await rawRequest(
        "PUT",
        url,
        headersFor(d.constraints, {
          "x-amz-checksum-sha256": createHash("sha256").update(other).digest("base64"),
        }),
        other,
      );
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, size: d.body.length },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "complete rejects (checksum_mismatch or object_missing)",
        pass: decision === "reject:checksum_mismatch" || decision === "reject:object_missing",
      };
    },

    "upload.bytes_swapped_with_declared_checksum": async (rng) => {
      const d = declare(rng, "raw_video");
      const other = seededBytes(rng, d.body.length);
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const storage = await rawRequest("PUT", url, headersFor(d.constraints, {}), other);
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, size: d.body.length },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "storage 400 XAmzContentChecksumMismatch + object absent",
        pass: storage.status === 400 && decision === "reject:object_missing",
      };
    },

    "upload.oversize_body": async (rng) => {
      const d = declare(rng, pick(rng, ["raw_video", "thumbnail"] as const));
      const extra = randomInt(rng, 1, 4096);
      const big = Buffer.concat([d.body, seededBytes(rng, extra)]);
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const storage = await rawRequest(
        "PUT",
        url,
        headersFor(d.constraints, {
          "content-length": String(big.length),
          "x-amz-checksum-sha256": createHash("sha256").update(big).digest("base64"),
        }),
        big,
      );
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, declared: d.body.length, sent: big.length },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "storage 403 SignatureDoesNotMatch + object absent",
        pass: storage.status === 403 && decision === "reject:object_missing",
      };
    },

    "upload.oversize_beyond_kind_cap": async (rng) => {
      // The API never signs above the per-kind cap; this checks that a signed
      // small declaration cannot be stretched to the cap by the client.
      const d = declare(rng, "thumbnail");
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const claimed = MAX_THUMBNAIL_BYTES + randomInt(rng, 1, 1024);
      const storage = await rawRequest(
        "PUT",
        url,
        headersFor(d.constraints, { "content-length": String(claimed) }),
        d.body,
      ).catch((error: Error) => ({
        status: 0,
        code: `client:${error.message}`,
        bodyPrefix: "",
        bodyBytes: 0,
      }));
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, declared: d.body.length, claimedContentLength: claimed },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "no object stored (storage refuses or connection fails)",
        pass: storage.status !== 200 && decision === "reject:object_missing",
      };
    },

    "upload.content_type_spoof": async (rng) => {
      const kind = pick(rng, ["raw_video", "thumbnail"] as const);
      const d = declare(rng, kind);
      const spoof = pick(rng, [
        "text/html",
        "application/x-msdownload",
        "image/svg+xml",
        ...(otherKind(kind) === "raw_video" ? ALLOWED_VIDEO_TYPES : ALLOWED_IMAGE_TYPES),
      ]);
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const storage = await rawRequest(
        "PUT",
        url,
        headersFor(d.constraints, { "content-type": spoof }),
        d.body,
      );
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, declared: d.constraints.contentType, sent: spoof },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "storage 403 SignatureDoesNotMatch + object absent",
        pass: storage.status === 403 && decision === "reject:object_missing",
      };
    },

    "upload.key_substitution_other_user": async (rng) => {
      const attacker = declare(rng, "raw_video");
      const victim = declare(rng, "raw_video");
      const victimHad = await honestUpload(store, victim);
      const url = await store.presignUpload(attacker.key, 900, attacker.constraints);
      const forged = substituteKey(url, env.bucket, victim.key);
      const storage = await rawRequest(
        "PUT",
        forged,
        headersFor(attacker.constraints, {}),
        attacker.body,
      );
      const victimHead = await store.headObject(victim.key);
      const overwritten =
        victimHead === null ||
        victimHead.checksumSha256 !== sha256HexToBase64(victim.constraints.sha256Hex);
      return {
        input: {
          signedKey: attacker.key,
          targetKey: victim.key,
          victimUploadStatus: victimHad.status,
        },
        storage,
        completeDecision: null,
        objectAffected: overwritten,
        expected: "storage 403 SignatureDoesNotMatch + victim object untouched",
        pass: storage.status === 403 && !overwritten,
      };
    },

    "upload.path_traversal": async (rng) => {
      const attacker = declare(rng, "raw_video");
      const victim = declare(rng, "raw_video");
      await honestUpload(store, victim);
      const victimLeaf = victim.key.split("/").pop() ?? "";
      const traversal = `media/${attacker.userId}/../${victim.userId}/${victimLeaf}`;
      const url = await store.presignUpload(attacker.key, 900, attacker.constraints);
      const forged = substituteKey(url, env.bucket, traversal);
      const storage = await rawRequest(
        "PUT",
        forged,
        headersFor(attacker.constraints, {}),
        attacker.body,
      );
      const victimHead = await store.headObject(victim.key);
      const overwritten =
        victimHead === null ||
        victimHead.checksumSha256 !== sha256HexToBase64(victim.constraints.sha256Hex);
      const literal = await literalKeyAddressable(store, traversal);
      return {
        input: { signedKey: attacker.key, traversalPath: traversal, victimKey: victim.key },
        storage,
        completeDecision: null,
        objectAffected: overwritten || literal.exists,
        expected: "storage refuses (403) + victim untouched + no literal traversal key",
        pass: storage.status === 403 && !overwritten && !literal.exists,
        ...(literal.error
          ? { note: `HEAD of literal traversal key refused: ${literal.error}` }
          : {}),
      };
    },

    "upload.bucket_substitution": async (rng) => {
      const d = declare(rng, "raw_video");
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const target = new URL(url);
      target.pathname = target.pathname.replace(`/${env.bucket}/`, `/${env.bucket}-other/`);
      const storage = await rawRequest(
        "PUT",
        target.toString(),
        headersFor(d.constraints, {}),
        d.body,
      );
      return {
        input: { key: d.key, bucketSent: `${env.bucket}-other` },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage refuses (403/404), never 200",
        pass: storage.status !== 200,
      };
    },

    "upload.signature_bitflip": async (rng) => {
      const d = declare(rng, "raw_video");
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const forged = flipSignatureNibble(url, rng);
      const storage = await rawRequest("PUT", forged, headersFor(d.constraints, {}), d.body);
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "storage 403 SignatureDoesNotMatch + object absent",
        pass: storage.status === 403 && decision === "reject:object_missing",
      };
    },

    "upload.expires_param_tamper": async (rng) => {
      const d = declare(rng, "raw_video");
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const forged = setQueryParam(url, "X-Amz-Expires", String(randomInt(rng, 901, 604800)));
      const storage = await rawRequest("PUT", forged, headersFor(d.constraints, {}), d.body);
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, tamperedExpires: new URL(forged).searchParams.get("X-Amz-Expires") },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "storage 403 SignatureDoesNotMatch + object absent",
        pass: storage.status === 403 && decision === "reject:object_missing",
      };
    },

    "upload.method_swap": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const url = await store.presignUpload(d.key, 900, d.constraints);
      const method = pick(rng, ["DELETE", "GET", "POST"] as const);
      const storage = await rawRequest(method, url, {});
      const stillThere = await objectExists(store, d.key);
      return {
        input: { key: d.key, method },
        storage,
        completeDecision: null,
        objectAffected: !stillThere,
        expected:
          "storage refuses (4xx, never 2xx; PUT signature does not authorize other verbs) + object intact",
        pass: storage.status >= 400 && storage.status < 500 && stillThere,
      };
    },

    "upload.expired_url": async (rng) => {
      const d = declare(rng, "raw_video");
      const url = await store.presignUpload(d.key, 1, d.constraints);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const storage = await rawRequest("PUT", url, headersFor(d.constraints, {}), d.body);
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key, expiresIn: 1, waitedMs: 2100 },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "storage 403 (expired) + object absent",
        pass: storage.status === 403 && decision === "reject:object_missing",
      };
    },

    "upload.anonymous_put": async (rng) => {
      const d = declare(rng, "raw_video");
      const storage = await rawRequest(
        "PUT",
        `${env.endpoint}/${env.bucket}/${d.key}`,
        headersFor(d.constraints, {}),
        d.body,
      );
      const decision = await completeDecision(store, d.key, d.constraints, MAX_UPLOAD_BYTES);
      return {
        input: { key: d.key },
        storage,
        completeDecision: decision,
        objectAffected: storage.status === 200,
        expected: "storage 403 AccessDenied + object absent",
        pass: storage.status === 403 && decision === "reject:object_missing",
      };
    },

    "download.honest": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const url = await store.presignDownload(d.key, 300);
      const storage = await rawRequest("GET", url, {});
      return {
        input: { key: d.key, size: d.body.length },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage 200 with the full body",
        pass: storage.status === 200 && storage.bodyBytes === d.body.length,
      };
    },

    "download.expired_url": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const url = await store.presignDownload(d.key, 1);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const storage = await rawRequest("GET", url, {});
      return {
        input: { key: d.key, expiresIn: 1, waitedMs: 2100 },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage 403 (expired), zero body bytes of media",
        pass: storage.status === 403,
      };
    },

    "download.expires_param_tamper": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const url = await store.presignDownload(d.key, 1);
      const forged = setQueryParam(url, "X-Amz-Expires", String(randomInt(rng, 3600, 604800)));
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const storage = await rawRequest("GET", forged, {});
      return {
        input: { key: d.key },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage 403 SignatureDoesNotMatch",
        pass: storage.status === 403,
      };
    },

    "download.key_substitution_other_user": async (rng) => {
      const attacker = declare(rng, "raw_video");
      const victim = declare(rng, "raw_video");
      await honestUpload(store, attacker);
      await honestUpload(store, victim);
      const url = await store.presignDownload(attacker.key, 300);
      const forged = substituteKey(url, env.bucket, victim.key);
      const storage = await rawRequest("GET", forged, {});
      return {
        input: { signedKey: attacker.key, targetKey: victim.key },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage 403 SignatureDoesNotMatch, zero victim bytes",
        pass: storage.status === 403 && storage.bodyBytes !== victim.body.length,
      };
    },

    "download.path_traversal": async (rng) => {
      const attacker = declare(rng, "raw_video");
      const victim = declare(rng, "raw_video");
      await honestUpload(store, victim);
      const victimLeaf = victim.key.split("/").pop() ?? "";
      const traversal = `media/${attacker.userId}/../${victim.userId}/${victimLeaf}`;
      const url = await store.presignDownload(attacker.key, 300);
      const forged = substituteKey(url, env.bucket, traversal);
      const storage = await rawRequest("GET", forged, {});
      return {
        input: { signedKey: attacker.key, traversalPath: traversal, victimKey: victim.key },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage refuses (403), zero victim bytes",
        pass: storage.status === 403 && storage.bodyBytes !== victim.body.length,
      };
    },

    "download.method_swap": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const url = await store.presignDownload(d.key, 300);
      const method = pick(rng, ["DELETE", "PUT"] as const);
      const storage = await rawRequest(
        method,
        url,
        method === "PUT" ? { "content-length": "3" } : {},
        method === "PUT" ? Buffer.from("abc") : undefined,
      );
      const head = await store.headObject(d.key);
      const intact =
        head !== null && head.checksumSha256 === sha256HexToBase64(d.constraints.sha256Hex);
      return {
        input: { key: d.key, method },
        storage,
        completeDecision: null,
        objectAffected: !intact,
        expected:
          "storage refuses (4xx, never 2xx; GET signature does not authorize other verbs) + object intact",
        pass: storage.status >= 400 && storage.status < 500 && intact,
      };
    },

    "download.signature_bitflip": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const url = await store.presignDownload(d.key, 300);
      const storage = await rawRequest("GET", flipSignatureNibble(url, rng), {});
      return {
        input: { key: d.key },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage 403 SignatureDoesNotMatch",
        pass: storage.status === 403,
      };
    },

    "anonymous.get_head_delete": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const base = `${env.endpoint}/${env.bucket}/${d.key}`;
      const get = await rawRequest("GET", base, {});
      const head = await rawRequest("HEAD", base, {});
      const del = await rawRequest("DELETE", base, {});
      const stillThere = await objectExists(store, d.key);
      return {
        input: { key: d.key, headStatus: head.status, deleteStatus: del.status },
        storage: get,
        completeDecision: null,
        objectAffected: !stillThere,
        expected: "GET/HEAD/DELETE all 403 + object intact",
        pass: get.status === 403 && head.status === 403 && del.status === 403 && stillThere,
      };
    },

    "anonymous.list_bucket": async (rng) => {
      const d = declare(rng, "raw_video");
      await honestUpload(store, d);
      const variants = [
        `${env.endpoint}/${env.bucket}/`,
        `${env.endpoint}/${env.bucket}?list-type=2&prefix=media/`,
        `${env.endpoint}/${env.bucket}?prefix=media/${d.userId}/`,
        `${env.endpoint}/`,
      ];
      const url = pick(rng, variants);
      const storage = await rawRequest("GET", url, {});
      return {
        input: { url },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "storage 403 AccessDenied, no key names in the body",
        pass: storage.status === 403 && !storage.bodyPrefix.includes(d.key),
      };
    },

    "object.tags_after_presigned_put": async (rng) => {
      // Informational: the terraform lifecycle rule only expires objects
      // tagged retention=default; this records what a presigned PUT leaves.
      const d = declare(rng, "raw_video");
      const storage = await honestUpload(store, d);
      const tags = await admin.send(
        new GetObjectTaggingCommand({ Bucket: env.bucket, Key: d.key }),
      );
      const tagSet = (tags.TagSet ?? []).map((tag) => `${tag.Key ?? ""}=${tag.Value ?? ""}`);
      return {
        input: { key: d.key },
        storage,
        completeDecision: null,
        objectAffected: null,
        expected: "recorded only (no assertion): tag set present on the stored object",
        pass: storage.status === 200,
        note: `tags=${JSON.stringify(tagSet)}`,
      };
    },
  };
}

export interface RunOptions {
  runSeed: number;
  casesPerFamily: number;
  /** Restrict to these families (all when omitted). */
  families?: string[];
  onCase?: (result: CaseResult) => void;
}

export async function runStoragePolicyMatrix(
  env: HarnessEnv,
  options: RunOptions,
): Promise<MatrixRun> {
  const store = buildHarnessStore(env);
  const families = buildFamilies(store, env);
  const selected = options.families ?? Object.keys(families);
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  const byFamily: MatrixSummary["byFamily"] = {};

  for (const family of selected) {
    const runner = families[family];
    if (!runner) throw new Error(`unknown family ${family}`);
    const familyRng = seededRng(hashSeed(options.runSeed, family));
    byFamily[family] = { total: 0, passed: 0, failed: 0 };
    for (let index = 0; index < options.casesPerFamily; index++) {
      const caseSeed = Math.floor(familyRng() * 0xffffffff);
      const rng = seededRng(caseSeed);
      let outcome: Omit<CaseResult, "id" | "family" | "caseSeed">;
      try {
        outcome = await runner(rng, index);
      } catch (error) {
        outcome = {
          input: {},
          storage: null,
          completeDecision: null,
          objectAffected: null,
          expected: "case completes without a harness error",
          pass: false,
          note: `harness error: ${(error as Error).message}`,
        };
      }
      const result: CaseResult = { id: `${family}#${index}`, family, caseSeed, ...outcome };
      results.push(result);
      const bucket = byFamily[family];
      if (bucket) {
        bucket.total += 1;
        if (result.pass) bucket.passed += 1;
        else bucket.failed += 1;
      }
      options.onCase?.(result);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    summary: {
      runSeed: options.runSeed,
      casesPerFamily: options.casesPerFamily,
      endpoint: env.endpoint,
      bucket: env.bucket,
      startedAt,
      finishedAt: new Date().toISOString(),
      total: results.length,
      passed,
      failed: results.length - passed,
      byFamily,
    },
    results,
  };
}

function hashSeed(runSeed: number, family: string): number {
  const digest = createHash("sha256").update(`${runSeed}:${family}`).digest();
  return digest.readUInt32LE(0);
}

/** Objects under the media/ prefix, for the post-run bucket inventory artifact. */
export async function inventory(env: HarnessEnv): Promise<{ count: number; sampleKeys: string[] }> {
  const admin = adminClient(env);
  let count = 0;
  const sampleKeys: string[] = [];
  let token: string | undefined;
  do {
    const page = await admin.send(
      new ListObjectsV2Command({
        Bucket: env.bucket,
        Prefix: "media/",
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const object of page.Contents ?? []) {
      count += 1;
      if (sampleKeys.length < 5 && object.Key) sampleKeys.push(object.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { count, sampleKeys };
}

/** Sanity probe used by the CLI to confirm the bucket exists before a run. */
export async function bucketReachable(env: HarnessEnv): Promise<boolean> {
  const admin = adminClient(env);
  try {
    await admin.send(new ListObjectsV2Command({ Bucket: env.bucket, MaxKeys: 1 }));
    return true;
  } catch {
    return false;
  }
}
