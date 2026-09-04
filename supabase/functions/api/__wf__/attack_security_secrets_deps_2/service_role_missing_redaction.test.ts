// Adversarial pass (security-secrets-deps #2, S3): with SUPABASE_SERVICE_ROLE_KEY
// unset, every write path that needs billingAdminDb() must answer a generic
// 5xx whose body never names the missing secret (or "service role"), must
// not crash, and must recover in-place once the key is present again (the
// admin client is created lazily and cached per isolate).
//
// This file must stay in its own module: billingAdminDb() caches the client
// after the first successful creation, so the env var has to be absent before
// any billing/deletion/webhook request in this isolate.
import { assert, assertEquals } from "@std/assert";
import {
  activeSubscriber,
  fakeAppleIdToken,
  fakeGoogleIdToken,
  loadHarness,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "../routesHarness.ts";

const h = await loadHarness();
const REAL_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
assert(REAL_KEY.length > 0, "harness sets a test service-role key");
Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");

const FORBIDDEN = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE",
  "service_role",
  "service role",
  "serviceRole",
  "billingAdminDb",
  "Deno.env",
  REAL_KEY,
];

function assertNeverNamesSecret(text: string, where: string) {
  for (const fragment of FORBIDDEN) {
    assertEquals(
      text.includes(fragment),
      false,
      `${where} names the missing secret via "${fragment}"`,
    );
  }
}

function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = { error: console.error, warn: console.warn };
  const record = (...args: unknown[]) => lines.push(args.map(String).join(" "));
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

const CHALLENGE = "55555555-5555-4555-8555-555555555555";

Deno.test(
  "S3: POST /v1/billing/sync without the service-role key → 503 billing_unconfigured, generic body",
  async () => {
    h.reset();
    h.subscriber = activeSubscriber();
    const log = captureConsole();
    let response: Response;
    try {
      response = await h.handler(
        userRequest("POST", "/v1/billing/sync", {
          ip: "203.0.113.101",
          body: {},
        }),
      );
    } finally {
      log.restore();
    }
    const text = await response.text();
    assertEquals(response.status, 503, text);
    const body = JSON.parse(text);
    assertEquals(body.error.code, "billing_unconfigured");
    assertEquals(body.error.message, "Billing verification is not configured on the server.");
    assertNeverNamesSecret(text, "billing/sync body");
    // The verdict was fetched from RevenueCat but nothing was persisted.
    assertEquals(h.calls.filter((c) => c.url.includes("/rest/v1/billing_entitlements")).length, 0);
  },
);

Deno.test(
  "S3: rapid concurrent billing syncs without the key never 5xx with detail (all 503 or 429)",
  async () => {
    h.reset();
    h.subscriber = activeSubscriber();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.handler(
          userRequest("POST", "/v1/billing/sync", {
            ip: `203.0.113.${110 + i}`,
            body: {},
          }),
        ),
      ),
    );
    for (const [i, r] of responses.entries()) {
      const text = await r.text();
      assert(r.status === 503 || r.status === 429, `repeat ${i}: ${r.status} ${text}`);
      assertNeverNamesSecret(text, `repeat ${i}`);
    }
  },
);

Deno.test(
  "S3: POST /v1/me/delete-confirm without the key → generic 503, nothing deleted",
  async () => {
    h.reset();
    h.tables.account_deletion_requests = [
      {
        challenge: CHALLENGE,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const response = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: fakeGoogleIdToken(),
        ip: "203.0.113.120",
        body: { challenge: CHALLENGE },
      }),
    );
    const text = await response.text();
    assertEquals(response.status, 503, text);
    assertEquals(JSON.parse(text), {
      error: {
        message: "Account deletion is temporarily unavailable. Please try again.",
      },
    });
    assertNeverNamesSecret(text, "delete-confirm body");
    assertEquals(
      h.calls.filter((c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE")
        .length,
      0,
    );
  },
);

Deno.test(
  "S3: RevenueCat webhook without the key → 503, generic, no audit row attempted",
  async () => {
    h.reset();
    const response = await h.handler(
      webhookRequest(
        {
          id: "evt-missing-service-role",
          type: "INITIAL_PURCHASE",
          app_user_id: TEST_USER_ID,
          event_timestamp_ms: Date.now(),
        },
        { ip: "203.0.113.130" },
      ),
    );
    const text = await response.text();
    assertEquals(response.status, 503, text);
    assertEquals(JSON.parse(text), {
      error: { message: "Webhook processing is not configured." },
    });
    assertNeverNamesSecret(text, "webhook body");
    assertEquals(h.calls.filter((c) => c.url.includes("/rest/v1/webhook_events")).length, 0);
  },
);

Deno.test(
  "S3: Apple bootstrap with an authorization code and no key → generic 503, Apple never called",
  async () => {
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
          ip: "203.0.113.140",
          body: { appleAuthorizationCode: "one-use-authorization-code" },
        }),
      );
    } finally {
      log.restore();
    }
    const text = await response.text();
    assertEquals(response.status, 503, text);
    assertEquals(JSON.parse(text), {
      error: {
        message: "Apple sign-in is temporarily unavailable. Please try again.",
      },
    });
    assertNeverNamesSecret(text, "bootstrap body");
    assertEquals(h.callsTo("appleid.apple.com/auth/token").length, 0);
  },
);

Deno.test("S3: read paths that do not need the service role keep working without it", async () => {
  h.reset();
  h.tables.profiles = [
    {
      id: TEST_USER_ID,
      email: "relay@example.com",
      provider: "google",
      onboarding_state: "complete",
    },
  ];
  const healthz = await h.handler(new Request("http://edge.test/functions/v1/api/healthz"));
  assertEquals(healthz.status, 200);
  const bootstrap = await h.handler(
    userRequest("POST", "/v1/account/bootstrap", {
      ip: "203.0.113.150",
      body: {},
    }),
  );
  assertEquals(bootstrap.status, 200, await bootstrap.text());
});

Deno.test(
  "S3x: REVENUECAT_WEBHOOK_AUTH unset → webhook fails closed (503, generic) even with the right header",
  async () => {
    const webhookSecret = Deno.env.get("REVENUECAT_WEBHOOK_AUTH") ?? "";
    assert(webhookSecret.length > 0, "harness sets a webhook secret");
    Deno.env.delete("REVENUECAT_WEBHOOK_AUTH");
    try {
      h.reset();
      for (const authorization of [webhookSecret, "", "Bearer anything"]) {
        const response = await h.handler(
          webhookRequest(
            {
              id: "evt-no-webhook-secret",
              type: "INITIAL_PURCHASE",
              app_user_id: TEST_USER_ID,
              event_timestamp_ms: Date.now(),
            },
            { ip: "203.0.113.170", authorization },
          ),
        );
        const text = await response.text();
        assertEquals(response.status, 503, text);
        assertEquals(JSON.parse(text), { error: { message: "Webhook is not configured." } });
        assertEquals(text.includes("REVENUECAT_WEBHOOK_AUTH"), false, text);
        assertEquals(text.includes(webhookSecret), false, text);
      }
      assertEquals(h.callsTo("api.revenuecat.com").length, 0, "RevenueCat never consulted");
      assertEquals(h.calls.filter((c) => c.url.includes("/rest/v1/webhook_events")).length, 0);
    } finally {
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", webhookSecret);
    }
  },
);

Deno.test("S3: restoring the key recovers billing writes in the same isolate", async () => {
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", REAL_KEY);
  h.reset();
  h.subscriber = activeSubscriber();
  h.rpcs["access_state"] = [
    {
      premium: false,
      scored_count: 0,
      reserved_count: 0,
    },
  ];
  const response = await h.handler(
    userRequest("POST", "/v1/billing/sync", { ip: "203.0.113.160", body: {} }),
  );
  const text = await response.text();
  assertEquals(response.status, 200, text);
  assertEquals(JSON.parse(text).billing.premium, true);
  const persisted = h.callsTo("/rest/v1/billing_entitlements");
  assertEquals(persisted.length, 1, "persist attempted exactly once after recovery");
  assertEquals(persisted[0].headers["apikey"], REAL_KEY);
});
