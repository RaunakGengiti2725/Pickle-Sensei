// Pre-auth request handling of the edge function, exercised through the
// real `Deno.serve` handler without a socket or a Supabase project: every
// path below is decided before any network call.
//
//   deno test --no-lock --node-modules-dir=none --no-check --allow-env \
//     --allow-read --allow-net supabase/functions/api/__wf__/index_preauth_test.ts
//
// (`--no-check` because index.ts carries the documented pre-existing
// untyped-supabase-client errors; `--node-modules-dir=none` because the repo
// root package.json is a pnpm workspace, not a Deno node_modules layout.)

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

type Handler = (request: Request) => Response | Promise<Response>;

Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "anon-test-key");
Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "webhook-secret-for-tests");
Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

let captured: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]): unknown => {
  const handler = args.find((a) => typeof a === "function") as Handler;
  captured = handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;

function handle(request: Request): Promise<Response> {
  if (!captured) throw new Error("index.ts did not register a Deno.serve handler");
  return Promise.resolve(captured(request));
}

const BASE = "https://example.test/functions/v1/api";

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fakeIdToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

async function errorBody(response: Response): Promise<{ message: string }> {
  const body = await response.json();
  return body.error;
}

Deno.test("healthz answers without auth", async () => {
  const response = await handle(new Request(`${BASE}/healthz`));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
});

Deno.test("an already-expired provider token is refused before any verification", async () => {
  const token = fakeIdToken({
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1_000) - 60,
  });
  const response = await handle(
    new Request(`${BASE}/v1/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-forwarded-for": "10.9.0.1",
      },
    }),
  );
  assertEquals(response.status, 401);
  assertStringIncludes((await errorBody(response)).message, "expired");
});

Deno.test(
  "repeated auth failures from one IP trip the auth-failure budget with a bucket-bounded Retry-After",
  async () => {
    const ip = `10.9.1.${Math.floor(Math.random() * 250)}`;
    const limit = 30;
    const windowSeconds = 300;
    for (let i = 0; i < limit; i += 1) {
      const response = await handle(
        new Request(`${BASE}/v1/me`, { headers: { "x-forwarded-for": ip } }),
      );
      assertEquals(response.status, 401, `failure ${i + 1} should still reach auth`);
      await response.body?.cancel();
    }
    const blocked = await handle(
      new Request(`${BASE}/v1/me`, {
        headers: {
          "x-forwarded-for": ip,
          Authorization: `Bearer ${fakeIdToken({ iss: "https://accounts.google.com" })}`,
        },
      }),
    );
    assertEquals(blocked.status, 429);
    const retryAfter = Number(blocked.headers.get("Retry-After"));
    assertEquals(Number.isInteger(retryAfter), true);
    assertEquals(retryAfter >= 1 && retryAfter <= windowSeconds, true);
    await blocked.body?.cancel();

    const other = await handle(
      new Request(`${BASE}/v1/me`, { headers: { "x-forwarded-for": "10.9.2.2" } }),
    );
    assertEquals(other.status, 401);
    await other.body?.cancel();
  },
);

Deno.test("a declared oversized body is refused with 413", async () => {
  const response = await handle(
    new Request(`${BASE}/v1/shots:sync`, {
      method: "POST",
      headers: {
        "content-length": String(5_000_001),
        "x-forwarded-for": "10.9.3.3",
      },
      body: "{}",
    }),
  );
  assertEquals(response.status, 413);
  await response.body?.cancel();
});

Deno.test("webhook: wrong shared secret is rejected", async () => {
  const response = await handle(
    new Request(`${BASE}/webhooks/revenuecat`, {
      method: "POST",
      headers: { Authorization: "nope", "x-forwarded-for": "10.9.4.4" },
      body: JSON.stringify({ event: { id: "e1", type: "TEST" } }),
    }),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
});

Deno.test("webhook: a chunked body past the cap is cut off with 413, not buffered", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > 5_000_000 + chunk.byteLength * 4) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
  const response = await handle(
    new Request(`${BASE}/webhooks/revenuecat`, {
      method: "POST",
      headers: {
        Authorization: "webhook-secret-for-tests",
        "x-forwarded-for": "10.9.5.5",
      },
      body: stream,
    }),
  );
  assertEquals(response.status, 413);
  assertStringIncludes((await errorBody(response)).message, "too large");
});

Deno.test("webhook: malformed JSON is a 400, not a crash", async () => {
  const response = await handle(
    new Request(`${BASE}/webhooks/revenuecat`, {
      method: "POST",
      headers: {
        Authorization: "webhook-secret-for-tests",
        "x-forwarded-for": "10.9.6.6",
      },
      body: "{not json",
    }),
  );
  assertEquals(response.status, 400);
  await response.body?.cancel();
});
