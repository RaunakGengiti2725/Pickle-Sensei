import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  ExternalAccountError,
  decryptAppleRefreshToken,
  deleteRevenueCatCustomer,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
  type AppleServerConfiguration,
} from "../externalAccounts.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const APPLE_SUBJECT = "001234.abcdef.5678";

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeIdentityToken(subject = APPLE_SUBJECT): string {
  return `${base64Url(JSON.stringify({ alg: "RS256" }))}.${base64Url(
    JSON.stringify({ sub: subject }),
  )}.signature`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function appleConfig(): Promise<AppleServerConfiguration> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const encoded =
    bytesToBase64(pkcs8)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return {
    clientId: "com.picklesensei",
    teamId: "TEAMID1234",
    keyId: "KEYID12345",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
    tokenEncryptionKey: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
  };
}

Deno.test(
  "Apple authorization-code exchange sends a signed client secret and returns the bound grant",
  async () => {
    const config = await appleConfig();
    let requestBody = "";
    const grant = await exchangeAppleAuthorizationCode(
      "one-use-code",
      config,
      async (input, init) => {
        const request = new Request(input, init);
        assertEquals(request.url, "https://appleid.apple.com/auth/token");
        assertEquals(request.method, "POST");
        assertEquals(request.headers.get("content-type"), "application/x-www-form-urlencoded");
        requestBody = await request.text();
        return Response.json({
          refresh_token: "apple-refresh-token",
          id_token: fakeIdentityToken(),
        });
      },
    );
    const form = new URLSearchParams(requestBody);
    assertEquals(form.get("client_id"), "com.picklesensei");
    assertEquals(form.get("code"), "one-use-code");
    assertEquals(form.get("grant_type"), "authorization_code");
    const secret = form.get("client_secret") ?? "";
    assertEquals(secret.split(".").length, 3);
    const payload = JSON.parse(
      atob((secret.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    );
    assertEquals(payload.iss, "TEAMID1234");
    assertEquals(payload.sub, "com.picklesensei");
    assertEquals(payload.aud, "https://appleid.apple.com");
    assertEquals(grant, { refreshToken: "apple-refresh-token", subject: APPLE_SUBJECT });
  },
);

Deno.test("Apple invalid_grant is distinguished from a retryable provider outage", async () => {
  const config = await appleConfig();
  await assertRejects(
    () =>
      exchangeAppleAuthorizationCode("spent-code", config, () =>
        Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })),
      ),
    ExternalAccountError,
    "authorization-code exchange failed",
  );
  try {
    await exchangeAppleAuthorizationCode("spent-code", config, () =>
      Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
  } catch (error) {
    assertEquals((error as ExternalAccountError).kind, "invalid_grant");
  }
});

Deno.test(
  "Apple refresh-token encryption round-trips and is bound to the canonical user",
  async () => {
    const config = await appleConfig();
    const encrypted = await encryptAppleRefreshToken(
      "highly-sensitive-refresh-token",
      USER_ID,
      config.tokenEncryptionKey,
    );
    assertStringIncludes(encrypted, "v1.");
    assertEquals(encrypted.includes("highly-sensitive-refresh-token"), false);
    assertEquals(
      await decryptAppleRefreshToken(encrypted, USER_ID, config.tokenEncryptionKey),
      "highly-sensitive-refresh-token",
    );
    await assertRejects(
      () =>
        decryptAppleRefreshToken(
          encrypted,
          "22222222-2222-4222-8222-222222222222",
          config.tokenEncryptionKey,
        ),
      ExternalAccountError,
      "could not be decrypted",
    );
  },
);

Deno.test("Apple revocation uses the refresh-token hint and accepts idempotent 200", async () => {
  const config = await appleConfig();
  let form: URLSearchParams | null = null;
  await revokeAppleRefreshToken("refresh-to-revoke", config, async (input, init) => {
    const request = new Request(input, init);
    assertEquals(request.url, "https://appleid.apple.com/auth/revoke");
    form = new URLSearchParams(await request.text());
    return new Response(null, { status: 200 });
  });
  assertEquals(form?.get("token"), "refresh-to-revoke");
  assertEquals(form?.get("token_type_hint"), "refresh_token");
});

Deno.test(
  "RevenueCat customer deletion requires the secret key and treats not-found as erased",
  async () => {
    let authorization = "";
    await deleteRevenueCatCustomer(USER_ID, "sk_secret", async (input, init) => {
      const request = new Request(input, init);
      assertEquals(
        request.url,
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(USER_ID)}`,
      );
      assertEquals(request.method, "DELETE");
      authorization = request.headers.get("authorization") ?? "";
      return new Response(null, { status: 404 });
    });
    assertEquals(authorization, "Bearer sk_secret");
    await assertRejects(
      () => deleteRevenueCatCustomer(USER_ID, "", () => Promise.resolve(new Response(null))),
      ExternalAccountError,
      "REVENUECAT_SECRET_API_KEY",
    );
  },
);
