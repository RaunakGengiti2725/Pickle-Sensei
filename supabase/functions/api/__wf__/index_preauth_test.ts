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
    // Only a credential Supabase Auth itself refuses counts as a failure, so
    // Auth answers `bad_jwt` here; everything else stays unreachable.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!new URL(url).pathname.endsWith("/auth/v1/user")) return realFetch(input, init);
      return Promise.resolve(
        new Response(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const forgedBearer = (salt: string) =>
      fakeIdToken({
        iss: `${Deno.env.get("SUPABASE_URL")}/auth/v1`,
        sub: "11111111-1111-4111-8111-111111111111",
        aud: "authenticated",
        role: "authenticated",
        session_id: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        salt,
      });
    try {
      for (let i = 0; i < limit; i += 1) {
        const response = await handle(
          new Request(`${BASE}/v1/me`, {
            headers: { "x-forwarded-for": ip, Authorization: `Bearer ${forgedBearer(`${i}`)}` },
          }),
        );
        assertEquals(response.status, 401, `failure ${i + 1} should still reach auth`);
        await response.body?.cancel();
      }
      const blocked = await handle(
        new Request(`${BASE}/v1/me`, {
          headers: {
            "x-forwarded-for": ip,
            Authorization: `Bearer ${forgedBearer("blocked")}`,
          },
        }),
      );
      assertEquals(blocked.status, 429);
      const retryAfter = Number(blocked.headers.get("Retry-After"));
      assertEquals(Number.isInteger(retryAfter), true);
      assertEquals(retryAfter >= 1 && retryAfter <= windowSeconds, true);
      await blocked.body?.cancel();

      const other = await handle(
        new Request(`${BASE}/v1/me`, {
          headers: {
            "x-forwarded-for": "10.9.2.2",
            Authorization: `Bearer ${forgedBearer("other")}`,
          },
        }),
      );
      assertEquals(other.status, 401);
      await other.body?.cancel();
    } finally {
      globalThis.fetch = realFetch;
    }
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

Deno.test("a large advisory content length does not preallocate the declared body", async () => {
  const request = new Request(`${BASE}/webhooks/revenuecat`, {
    method: "POST",
    headers: {
      Authorization: "webhook-secret-for-tests",
      "content-length": "524288",
      "x-forwarded-for": "10.9.5.6",
    },
    body: "{}",
  });
  const Original = globalThis.Uint8Array;
  const allocations: number[] = [];
  globalThis.Uint8Array = new Proxy(Original, {
    construct(target, args, newTarget) {
      if (typeof args[0] === "number") allocations.push(args[0]);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const response = await handle(request);
    assertEquals(response.status, 400);
    await response.body?.cancel();
    assertEquals(
      allocations.filter((size) => size > 8192),
      [],
    );
  } finally {
    globalThis.Uint8Array = Original;
  }
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

Deno.test(
  "stalled bodies hit a fixed 30s whole-body deadline and release their reader",
  async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let deadlineTimer: number | undefined;
    let deadlineCount = 0;
    let deadlineCleared = false;
    let cancelled = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode('{"refreshToken":'));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const request = new Request(`${BASE}/v1/auth/refresh`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.9.7.7" },
      body: stream,
    });
    const realAdd = request.signal.addEventListener;
    const realRemove = request.signal.removeEventListener;
    let listeners = 0;
    request.signal.addEventListener = function (...args: Parameters<typeof realAdd>) {
      if (args[0] === "abort") listeners += 1;
      return realAdd.apply(this, args);
    };
    request.signal.removeEventListener = function (...args: Parameters<typeof realRemove>) {
      if (args[0] === "abort") listeners -= 1;
      return realRemove.apply(this, args);
    };
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 30_000) {
        deadlineCount += 1;
        deadlineTimer = realSetTimeout(callback, 20, ...args);
        return deadlineTimer;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = (id?: number) => {
      if (id === deadlineTimer && id !== undefined) deadlineCleared = true;
      realClearTimeout(id);
    };
    let watchdog: number | undefined;
    const pending = handle(request);
    try {
      const response = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          watchdog = realSetTimeout(() => reject(new Error("body read never timed out")), 500);
        }),
      ]);
      assertEquals(response.status, 408);
      await response.text();
      assertEquals(cancelled, true);
      assertEquals(stream.locked, false);
      assertEquals(deadlineCleared, true);
      assertEquals(deadlineCount, 1);
      assertEquals(listeners, 0);
    } finally {
      realClearTimeout(watchdog);
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      if (!cancelled) controller!.close();
      await pending;
    }
  },
);

for (const preAborted of [true, false]) {
  Deno.test(
    `request abort (${preAborted ? "already aborted" : "during read"}) cancels the body and releases its reader`,
    async () => {
      const abort = new AbortController();
      let cancelled = false;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel() {
          cancelled = true;
        },
      });
      if (preAborted) abort.abort();
      const request = new Request(`${BASE}/v1/auth/refresh`, {
        method: "POST",
        headers: { "x-forwarded-for": preAborted ? "10.9.8.1" : "10.9.8.2" },
        body: stream,
        signal: abort.signal,
      });
      const pending = handle(request);
      let watchdog: number | undefined;
      const abortTimer = preAborted ? undefined : setTimeout(() => abort.abort(), 20);
      try {
        const response = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(() => reject(new Error("aborted body read did not stop")), 500);
          }),
        ]);
        assertEquals(response.status, 400);
        await response.text();
        assertEquals(cancelled, true);
        assertEquals(stream.locked, false);
      } finally {
        clearTimeout(watchdog);
        clearTimeout(abortTimer);
        if (!cancelled) controller!.close();
        await pending;
      }
    },
  );
}

Deno.test(
  "non-object JSON is rejected explicitly rather than treated as an empty optional body",
  async () => {
    for (const body of ["[]", "null", '"text"', "42", "false"]) {
      const request = new Request(`${BASE}/v1/auth/refresh`, {
        method: "POST",
        headers: { "x-forwarded-for": "10.9.9.1" },
        body,
      });
      const response = await handle(request);
      assertEquals(response.status, 400);
      assertStringIncludes((await errorBody(response)).message, "JSON object");
      assertEquals(request.body!.locked, false);
    }
  },
);

Deno.test(
  "bounded JSON reads handle many tiny UTF-8 chunks and release the lock on success",
  async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ pad: "é".repeat(20_000) }));
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.byteLength) controller.enqueue(bytes.subarray(offset, ++offset));
        else controller.close();
      },
    });
    const response = await handle(
      new Request(`${BASE}/v1/auth/refresh`, {
        method: "POST",
        headers: { "x-forwarded-for": "10.9.9.2" },
        body: stream,
      }),
    );
    assertEquals(response.status, 400);
    assertStringIncludes((await errorBody(response)).message, "refreshToken");
    assertEquals(stream.locked, false);
  },
);
