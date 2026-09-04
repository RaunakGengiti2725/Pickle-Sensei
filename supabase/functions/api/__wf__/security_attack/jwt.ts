// Test-only JWT tooling for the auth attack harness: base64url helpers,
// HS256 / RS256 signing + verification with Web Crypto, and a deterministic
// PRNG so every generated attack input is replayable from a seed.
//
// Nothing here is a real credential. The HS256 secret and the RSA key pairs
// are generated for the test process (or are obviously-fake constants) and
// exist only so the fake Supabase Auth can behave like GoTrue: verify the
// signature, refuse `alg:none`, refuse the wrong key.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlEncode(text: string): string {
  return b64urlEncodeBytes(encoder.encode(text));
}

export function b64urlDecodeBytes(segment: string): Uint8Array<ArrayBuffer> {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function b64urlDecode(segment: string): string {
  return decoder.decode(b64urlDecodeBytes(segment));
}

export type JwtClaims = Record<string, unknown>;

export function decodeSegment(segment: string): JwtClaims | null {
  try {
    const parsed = JSON.parse(b64urlDecode(segment)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JwtClaims)
      : null;
  } catch {
    return null;
  }
}

export function splitJwt(token: string): { header: string; payload: string; signature: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return { header: parts[0], payload: parts[1], signature: parts[2] };
}

// ─── HS256 ──────────────────────────────────────────────────────────────────

const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

export async function signHs256(
  header: JwtClaims,
  payload: JwtClaims,
  secret: string,
): Promise<string> {
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(signingInput),
  );
  return `${signingInput}.${b64urlEncodeBytes(new Uint8Array(signature))}`;
}

export async function verifyHs256(token: string, secret: string): Promise<boolean> {
  const parts = splitJwt(token);
  if (!parts) return false;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64urlDecodeBytes(parts.signature);
  } catch {
    return false;
  }
  if (signature.length !== 32) return false;
  return await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`${parts.header}.${parts.payload}`),
  );
}

// ─── RS256 (provider ID tokens) ─────────────────────────────────────────────

export interface RsaSigner {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function generateRsaSigner(kid: string): Promise<RsaSigner> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return { kid, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

export async function signRs256(
  header: JwtClaims,
  payload: JwtClaims,
  signer: RsaSigner,
): Promise<string> {
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${b64urlEncodeBytes(new Uint8Array(signature))}`;
}

export async function verifyRs256(token: string, signer: RsaSigner): Promise<boolean> {
  const parts = splitJwt(token);
  if (!parts) return false;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64urlDecodeBytes(parts.signature);
  } catch {
    return false;
  }
  if (signature.length !== 256) return false;
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    signer.publicKey,
    signature,
    encoder.encode(`${parts.header}.${parts.payload}`),
  );
}

/** Assemble a token from arbitrary parts (no signing) — for alg:none,
 * garbage signatures, header/payload swaps and other forgeries. */
export function assembleJwt(header: JwtClaims, payload: JwtClaims, signature: string): string {
  return `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}.${signature}`;
}

// ─── Deterministic PRNG ─────────────────────────────────────────────────────

/** mulberry32: small, fast, and reproducible from a 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomB64url(rng: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += B64URL_ALPHABET[randomInt(rng, 64)];
  return out;
}

/** Flip one base64url character of `segment` at a seeded position. */
export function mutateSegment(rng: () => number, segment: string): string {
  if (!segment) return "A";
  const index = randomInt(rng, segment.length);
  let replacement = segment[index];
  while (replacement === segment[index]) replacement = B64URL_ALPHABET[randomInt(rng, 64)];
  return segment.slice(0, index) + replacement + segment.slice(index + 1);
}
