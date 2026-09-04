// Adversarial pass (security-secrets-deps #2, S2): with a malformed
// APPLE_SIGN_IN_PRIVATE_KEY the account-deletion and Apple-bootstrap error
// paths must stay generic — no PEM material, no env var name, no key value in
// the response body, and nothing beyond the ExternalAccountError message in
// the server log. The real handler runs through routesHarness (no network).
import { assert, assertEquals } from "@std/assert";
import { encryptAppleRefreshToken } from "../../externalAccounts.ts";
import { fakeAppleIdToken, loadHarness, TEST_USER_ID, userRequest } from "../routesHarness.ts";

const h = await loadHarness();
const GOOD_PEM = Deno.env.get("APPLE_SIGN_IN_PRIVATE_KEY") ?? "";
assert(GOOD_PEM.includes("PRIVATE KEY"), "harness must have generated a real test PEM");

const CHALLENGE = "44444444-4444-4444-8444-444444444444";
const GENERIC_DELETE = "Account deletion is temporarily unavailable. Please try again.";
const GENERIC_APPLE_SIGNIN = "Apple sign-in is temporarily unavailable. Please try again.";

/** PEM armor is assembled at runtime so this fixture file never contains a
 * literal private-key header (the repo's own gitleaks gate would flag it). */
const DASHES = "-".repeat(5);
function pemArmor(body: string, kind = ""): string {
  const label = `${kind}${kind ? " " : ""}PRIVATE KEY`;
  return `${DASHES}BEGIN ${label}${DASHES}\n${body}\n${DASHES}END ${label}${DASHES}`;
}

/** Strings that must never reach a client (or the log) on these paths: PEM
 * armor, the raw key value, crypto internals. (Env var NAMES in the server
 * log are checked separately — operators need them; clients must not.) */
function forbiddenFragments(keyValue: string, opts: { envNames: boolean }): string[] {
  const fragments = [
    "PRIVATE KEY",
    "BEGIN",
    "pkcs8",
    "importKey",
    "DOMException",
    "DataError",
    "atob",
  ];
  if (opts.envNames) {
    fragments.push("APPLE_SIGN_IN_PRIVATE_KEY", "APPLE_TOKEN_ENCRYPTION_KEY");
  }
  // The planted value itself (and its first 16 chars, in case it is truncated).
  const trimmed = keyValue
    .split("\n")
    .filter((line) => !line.startsWith(DASHES))
    .join("\n")
    .trim();
  if (trimmed.length >= 8) fragments.push(trimmed.slice(0, 16));
  return fragments;
}

function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = { error: console.error, warn: console.warn };
  const record = (...args: unknown[]) =>
    lines.push(
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
    );
  console.error = record;
  console.warn = record;
  return {
    lines,
    restore() {
      console.error = original.error;
      console.warn = original.warn;
    },
  };
}

/** delete-confirm is budgeted 5/h PER USER, so every attempt below signs in as
 * a fresh synthetic user (deterministic UUIDs, seed 20260904). */
let userSeq = 0;
function nextUser(): string {
  userSeq += 1;
  return `20260904-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
}

async function seedAppleDeletion(userId: string): Promise<void> {
  h.reset();
  h.tables.account_deletion_requests = [
    {
      challenge: CHALLENGE,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
  h.tables.account_external_credentials = [
    {
      apple_refresh_token_encrypted: await encryptAppleRefreshToken(
        "refresh-to-revoke",
        userId,
        h.appleTokenEncryptionKey,
      ),
      apple_revoked_at: null,
      revenuecat_deleted_at: null,
    },
  ];
}

async function deleteConfirm(userId: string, ip: string): Promise<Response> {
  return await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: fakeAppleIdToken(userId),
      ip,
      body: { challenge: CHALLENGE },
    }),
  );
}

function assertRedacted(text: string, keyValue: string, where: string, envNames = true) {
  for (const fragment of forbiddenFragments(keyValue, { envNames })) {
    assertEquals(text.includes(fragment), false, `${where} leaked "${fragment.slice(0, 24)}"`);
  }
}

const MALFORMED_KEYS: Array<{ label: string; value: string }> = [
  { label: "plain string 'not-a-key'", value: "not-a-key" },
  {
    label: "PEM armor with garbage base64 body",
    value: pemArmor("bm90LWEta2V5LW5vdC1hLWtleQ=="),
  },
  {
    label: "PEM armor around non-base64 unicode",
    value: pemArmor("🔑🔑🔑 ключ 鍵 مفتاح"),
  },
  {
    label: "PEM armor with empty body",
    value: pemArmor(""),
  },
  {
    label: "1 MiB of 'A' (valid base64, not a key)",
    value: "A".repeat(1 << 20),
  },
  {
    label: "RSA-style armor (wrong key type)",
    value: pemArmor("AAAA", "RSA"),
  },
];

Deno.test(
  "S2: malformed APPLE_SIGN_IN_PRIVATE_KEY → account deletion is a generic 503 without PEM/env material",
  async () => {
    let ipOctet = 100;
    try {
      for (const { label, value } of MALFORMED_KEYS) {
        Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", value);
        const ip = `198.51.100.${ipOctet++}`;
        const user = nextUser();
        await seedAppleDeletion(user);
        const log = captureConsole();
        let response: Response;
        try {
          response = await deleteConfirm(user, ip);
        } finally {
          log.restore();
        }
        const text = await response.text();
        assertEquals(response.status, 503, `${label}: status`);
        assertEquals(JSON.parse(text), { error: { message: GENERIC_DELETE } }, `${label}: body`);
        assertRedacted(text, value, `${label}: response body`);
        assertRedacted(log.lines.join("\n"), value, `${label}: server log`, false);
        // Fail closed: Apple revoke never attempted, Supabase user NOT deleted.
        assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 0, `${label}: revoke call`);
        assertEquals(
          h.calls.filter((c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE")
            .length,
          0,
          `${label}: deleteUser call`,
        );
      }
    } finally {
      Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", GOOD_PEM);
    }
  },
);

Deno.test(
  "S2: rapid repeats with the bad key are all identical generic 503s (no state corruption)",
  async () => {
    Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", "not-a-key");
    try {
      // 4 concurrent attempts by ONE user stay under the 5/h delete_confirm budget.
      const user = nextUser();
      await seedAppleDeletion(user);
      const responses = await Promise.all(
        Array.from({ length: 4 }, (_, i) => deleteConfirm(user, `198.51.100.${200 + i}`)),
      );
      const bodies = await Promise.all(responses.map((r) => r.text()));
      for (const [i, r] of responses.entries()) {
        assertEquals(r.status, 503, `repeat ${i}`);
        assertEquals(
          JSON.parse(bodies[i]),
          {
            error: { message: GENERIC_DELETE },
          },
          `repeat ${i}`,
        );
      }
    } finally {
      Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", GOOD_PEM);
    }
  },
);

Deno.test(
  "S2: restoring the key recovers deletion in the same isolate (config is read lazily)",
  async () => {
    Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", GOOD_PEM);
    const user = nextUser();
    await seedAppleDeletion(user);
    const response = await deleteConfirm(user, "198.51.100.220");
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(await response.json(), {
      deleted: true,
      appleAuthorizationRevocation: "revoked",
    });
    assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
  },
);

Deno.test(
  "S2: Apple bootstrap with an authorization code and a bad key → generic 503, no Apple call, nothing stored",
  async () => {
    Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", "not-a-key");
    try {
      h.reset();
      h.tables.profiles = [
        {
          id: TEST_USER_ID,
          email: "relay@example.com",
          provider: "apple",
          onboarding_state: "complete",
        },
      ];
      const log = captureConsole();
      let response: Response;
      try {
        response = await h.handler(
          userRequest("POST", "/v1/account/bootstrap", {
            token: fakeAppleIdToken(),
            ip: "198.51.100.230",
            body: { appleAuthorizationCode: "one-use-authorization-code" },
          }),
        );
      } finally {
        log.restore();
      }
      const text = await response.text();
      assertEquals(response.status, 503);
      assertEquals(JSON.parse(text), {
        error: { message: GENERIC_APPLE_SIGNIN },
      });
      assertRedacted(text, "not-a-key", "bootstrap body");
      assertRedacted(log.lines.join("\n"), "not-a-key", "bootstrap log", false);
      assertEquals(h.callsTo("appleid.apple.com/auth/token").length, 0);
      assertEquals(
        h.calls.filter(
          (c) => c.url.includes("/rest/v1/account_external_credentials") && c.method === "POST",
        ).length,
        0,
      );
    } finally {
      Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", GOOD_PEM);
    }
  },
);

Deno.test(
  "S2: a BLANK key is 'unconfigured' (503) rather than a crash, and names no secret",
  async () => {
    Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", "   ");
    try {
      const user = nextUser();
      await seedAppleDeletion(user);
      const response = await deleteConfirm(user, "198.51.100.240");
      const text = await response.text();
      assertEquals(response.status, 503);
      assertEquals(JSON.parse(text), { error: { message: GENERIC_DELETE } });
      assertRedacted(text, "", "blank-key body");
    } finally {
      Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", GOOD_PEM);
    }
  },
);

Deno.test(
  "S2x: the server log for a non-base64 private key names the PRIVATE KEY, not the encryption key",
  async () => {
    // decodeBase64() in externalAccounts.ts is shared by both secrets and hard-
    // codes the APPLE_TOKEN_ENCRYPTION_KEY wording; an operator debugging a bad
    // APPLE_SIGN_IN_PRIVATE_KEY would be sent to the wrong secret.
    Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", "not-a-key!!");
    try {
      const user = nextUser();
      await seedAppleDeletion(user);
      const log = captureConsole();
      try {
        const response = await deleteConfirm(user, "198.51.100.250");
        assertEquals(response.status, 503);
      } finally {
        log.restore();
      }
      const joined = log.lines.join("\n");
      assert(
        joined.includes("Account deletion"),
        `expected a server-side detail line, got: ${joined}`,
      );
      assertEquals(
        joined.includes("APPLE_TOKEN_ENCRYPTION_KEY"),
        false,
        `log blames the wrong secret: ${joined}`,
      );
    } finally {
      Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", GOOD_PEM);
    }
  },
);

Deno.test(
  "S2x: server-side 503s on delete-confirm consume the user's 5/h budget (then 429 even once the key is fixed)",
  async () => {
    // Observation probe (documents behaviour, expected to pass): a misconfigured
    // Apple key makes every attempt fail with 503, yet each still counts against
    // the per-user delete_confirm budget, so the 6th attempt is 429 even after
    // the operator restores the key — the user is locked out for an hour.
    const user = nextUser();
    Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", "not-a-key");
    try {
      await seedAppleDeletion(user);
      for (let i = 0; i < 5; i += 1) {
        const r = await deleteConfirm(user, "198.51.100.60");
        const text = await r.text();
        assertEquals(r.status, 503, `attempt ${i}: ${text}`);
      }
    } finally {
      Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", GOOD_PEM);
    }
    const afterFix = await deleteConfirm(user, "198.51.100.60");
    const afterFixText = await afterFix.text();
    assertEquals(afterFix.status, 429, afterFixText);
    assert(afterFix.headers.get("retry-after"), "429 carries Retry-After");
  },
);
