// Server-side identity/billing cleanup primitives used by account bootstrap
// and deletion. This module deliberately has no Supabase dependency so the
// secret-handling and provider HTTP contracts can be tested in isolation.

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const REVENUECAT_SUBSCRIBER_URL = "https://api.revenuecat.com/v1/subscribers/";
const APPLE_AAD_PREFIX = "pickle-sensei/apple-refresh-token/v1/";
const REQUEST_TIMEOUT_MS = 15_000;

export interface AppleServerConfiguration {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  tokenEncryptionKey: string;
}

export interface AppleTokenGrant {
  refreshToken: string;
  subject: string;
}

export class ExternalAccountError extends Error {
  constructor(
    readonly kind: "configuration" | "invalid_grant" | "invalid_response" | "unavailable",
    readonly provider: "apple" | "revenuecat",
    message: string,
  ) {
    super(message);
    this.name = "ExternalAccountError";
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ExternalAccountError(
      "configuration",
      "apple",
      "APPLE_TOKEN_ENCRYPTION_KEY is not valid base64.",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function privateKeyBytes(pem: string): Uint8Array<ArrayBuffer> {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const encoded = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  if (!encoded) {
    throw new ExternalAccountError(
      "configuration",
      "apple",
      "The Sign in with Apple private key is empty.",
    );
  }
  return decodeBase64(encoded);
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const bytes = decodeBase64(segment);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function appleClientSecret(
  config: AppleServerConfiguration,
  nowMs = Date.now(),
): Promise<string> {
  const values = [config.clientId, config.teamId, config.keyId, config.privateKeyPem];
  if (values.some((value) => !value.trim())) {
    throw new ExternalAccountError(
      "configuration",
      "apple",
      "The Sign in with Apple server configuration is incomplete.",
    );
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes(config.privateKeyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof ExternalAccountError) throw error;
    throw new ExternalAccountError(
      "configuration",
      "apple",
      "The Sign in with Apple private key could not be imported.",
    );
  }

  const issuedAt = Math.floor(nowMs / 1_000);
  const header = base64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" })),
  );
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: config.teamId,
        iat: issuedAt,
        exp: issuedAt + 300,
        aud: "https://appleid.apple.com",
        sub: config.clientId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  if (signature.byteLength !== 64) {
    throw new ExternalAccountError(
      "configuration",
      "apple",
      "The Sign in with Apple signer returned an unsupported signature.",
    );
  }
  return `${signingInput}.${base64Url(signature)}`;
}

async function providerRequest(
  url: string,
  init: RequestInit,
  provider: "apple" | "revenuecat",
  fetchFn: FetchLike,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch {
    throw new ExternalAccountError("unavailable", provider, `${provider} could not be reached.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function appleFormRequest(
  url: string,
  values: Record<string, string>,
  config: AppleServerConfiguration,
  fetchFn: FetchLike,
): Promise<Response> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: await appleClientSecret(config),
    ...values,
  });
  return providerRequest(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    "apple",
    fetchFn,
  );
}

async function appleErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as unknown;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const code = (body as Record<string, unknown>).error;
      return typeof code === "string" ? code : null;
    }
  } catch {
    // Apple sometimes sends an empty error body. Status is enough below.
  }
  return null;
}

/** Exchange Apple's one-use authorization code for the refresh token needed
 * to revoke the user's authorization later. The id_token in Apple's direct
 * response supplies the subject that the caller must bind to the already
 * verified bootstrap identity. */
export async function exchangeAppleAuthorizationCode(
  authorizationCode: string,
  config: AppleServerConfiguration,
  fetchFn: FetchLike = fetch,
): Promise<AppleTokenGrant> {
  const response = await appleFormRequest(
    APPLE_TOKEN_URL,
    { code: authorizationCode, grant_type: "authorization_code" },
    config,
    fetchFn,
  );
  if (!response.ok) {
    const code = await appleErrorCode(response);
    throw new ExternalAccountError(
      code === "invalid_grant" ? "invalid_grant" : "unavailable",
      "apple",
      `Apple authorization-code exchange failed (${response.status}${code ? ` ${code}` : ""}).`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const refreshToken = record?.refresh_token;
  const idToken = record?.id_token;
  const subject = typeof idToken === "string" ? jwtPayload(idToken)?.sub : null;
  if (
    typeof refreshToken !== "string" ||
    !refreshToken.trim() ||
    typeof subject !== "string" ||
    !subject.trim()
  ) {
    throw new ExternalAccountError(
      "invalid_response",
      "apple",
      "Apple returned an incomplete token grant.",
    );
  }
  return { refreshToken, subject };
}

/** Apple's revoke endpoint is idempotent: it returns 200 for a token that was
 * revoked previously, so a later Supabase failure can safely be retried. */
export async function revokeAppleRefreshToken(
  refreshToken: string,
  config: AppleServerConfiguration,
  fetchFn: FetchLike = fetch,
): Promise<void> {
  const response = await appleFormRequest(
    APPLE_REVOKE_URL,
    { token: refreshToken, token_type_hint: "refresh_token" },
    config,
    fetchFn,
  );
  if (!response.ok) {
    const code = await appleErrorCode(response);
    throw new ExternalAccountError(
      "unavailable",
      "apple",
      `Apple token revocation failed (${response.status}${code ? ` ${code}` : ""}).`,
    );
  }
}

async function encryptionKey(encodedKey: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const bytes = decodeBase64(encodedKey);
  if (bytes.byteLength !== 32) {
    throw new ExternalAccountError(
      "configuration",
      "apple",
      "APPLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.",
    );
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usage);
}

/** Encrypt a refresh token before database storage. The canonical account id
 * is authenticated as AAD, preventing ciphertext from being moved between
 * users even by a privileged database mistake. */
export async function encryptAppleRefreshToken(
  refreshToken: string,
  userId: string,
  encodedKey: string,
): Promise<string> {
  const key = await encryptionKey(encodedKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(`${APPLE_AAD_PREFIX}${userId}`),
      },
      key,
      new TextEncoder().encode(refreshToken),
    ),
  );
  return `v1.${base64Url(iv)}.${base64Url(ciphertext)}`;
}

export async function decryptAppleRefreshToken(
  encrypted: string,
  userId: string,
  encodedKey: string,
): Promise<string> {
  const [version, encodedIv, encodedCiphertext, extra] = encrypted.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra !== undefined) {
    throw new ExternalAccountError(
      "invalid_response",
      "apple",
      "The stored Apple credential has an unsupported format.",
    );
  }
  const key = await encryptionKey(encodedKey, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64(encodedIv),
        additionalData: new TextEncoder().encode(`${APPLE_AAD_PREFIX}${userId}`),
      },
      key,
      decodeBase64(encodedCiphertext),
    );
    const token = new TextDecoder().decode(plaintext);
    if (!token) throw new Error("empty token");
    return token;
  } catch (error) {
    if (error instanceof ExternalAccountError) throw error;
    throw new ExternalAccountError(
      "invalid_response",
      "apple",
      "The stored Apple credential could not be decrypted.",
    );
  }
}

/** Permanently delete the canonical RevenueCat subscriber. An absent customer
 * is already the desired state and therefore succeeds for retry purposes. */
export async function deleteRevenueCatCustomer(
  appUserId: string,
  secretApiKey: string,
  fetchFn: FetchLike = fetch,
): Promise<void> {
  if (!secretApiKey.trim()) {
    throw new ExternalAccountError(
      "configuration",
      "revenuecat",
      "REVENUECAT_SECRET_API_KEY is not configured.",
    );
  }
  const response = await providerRequest(
    `${REVENUECAT_SUBSCRIBER_URL}${encodeURIComponent(appUserId)}`,
    {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: `Bearer ${secretApiKey}` },
    },
    "revenuecat",
    fetchFn,
  );
  if (!response.ok && response.status !== 404) {
    throw new ExternalAccountError(
      "unavailable",
      "revenuecat",
      `RevenueCat customer deletion failed (${response.status}).`,
    );
  }
}
