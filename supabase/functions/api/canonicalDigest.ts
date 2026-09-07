import canonicalize from "canonicalize";
import { validateOfflineSignedGrantShape } from "../../../packages/shared-types/src/offlineAuthorization.ts";

export const OFFLINE_DIGEST_TRUST_BOUNDARY =
  "Digests bind bytes, not scientific validity, billing eligibility, entitlement, trusted time or attestation. RFC8785 input is an already parsed JSON data value with finite IEEE-754 numbers; parsing source JSON and rejecting duplicate member names must happen before this boundary. Compact-grant hashing checks transport shape only, not the signature.";

export const OFFLINE_CANONICAL_JSON_LIMITS = Object.freeze({
  maxUtf8Bytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 100_000,
});

export class CanonicalDigestError extends Error {
  constructor(readonly code: "invalid_json" | "json_too_large" | "invalid_compact_grant") {
    super(`Offline digest rejected: ${code}`);
    this.name = "CanonicalDigestError";
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalizeOfflineJson(value: unknown): string {
  let nodes = 0;
  let stringUnits = 0;
  const ancestors = new Set<object>();

  function countString(value: string): void {
    stringUnits += value.length;
    if (stringUnits > OFFLINE_CANONICAL_JSON_LIMITS.maxUtf8Bytes) {
      throw new CanonicalDigestError("json_too_large");
    }
  }

  function snapshot(value: unknown, depth: number): JsonValue {
    nodes += 1;
    if (
      depth > OFFLINE_CANONICAL_JSON_LIMITS.maxDepth ||
      nodes > OFFLINE_CANONICAL_JSON_LIMITS.maxNodes
    ) {
      throw new CanonicalDigestError("json_too_large");
    }
    if (typeof value === "string") {
      countString(value);
      return value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object" || ancestors.has(value)) {
      throw new CanonicalDigestError("invalid_json");
    }
    ancestors.add(value);
    let copy: JsonValue;
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      ) {
        throw new CanonicalDigestError("invalid_json");
      }
      const array: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !("value" in property) || !property.enumerable) {
          throw new CanonicalDigestError("invalid_json");
        }
        array.push(snapshot(property.value, depth + 1));
      }
      copy = array;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalDigestError("invalid_json");
      }
      const object: { [key: string]: JsonValue } = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (
          typeof key !== "string" ||
          !property ||
          !("value" in property) ||
          !property.enumerable
        ) {
          throw new CanonicalDigestError("invalid_json");
        }
        countString(key);
        object[key] = snapshot(property.value, depth + 1);
      }
      copy = object;
    }
    ancestors.delete(value);
    return copy;
  }

  try {
    const serialized = canonicalize(snapshot(value, 0));
    if (typeof serialized !== "string") throw new CanonicalDigestError("invalid_json");
    if (
      new TextEncoder().encode(serialized).byteLength > OFFLINE_CANONICAL_JSON_LIMITS.maxUtf8Bytes
    ) {
      throw new CanonicalDigestError("json_too_large");
    }
    return serialized;
  } catch (error) {
    if (error instanceof CanonicalDigestError) throw error;
    throw new CanonicalDigestError("invalid_json");
  }
}

export async function digestCanonicalOfflineJson(value: unknown): Promise<string> {
  return await sha256Utf8(canonicalizeOfflineJson(value));
}

export async function digestOfflineGrantTransport(raw: unknown): Promise<string> {
  const transport = validateOfflineSignedGrantShape(raw);
  if (!transport.ok) throw new CanonicalDigestError("invalid_compact_grant");
  return await sha256Utf8(transport.value.compactJws);
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
