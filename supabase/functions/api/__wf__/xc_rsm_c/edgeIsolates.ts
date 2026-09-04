// Loads the REAL edge function (../../index.ts) as one or more independent
// isolates. Each isolate gets its own copy of cache.ts (L1 memory) and
// rateLimit.ts (memory windows) by re-materializing those modules under
// unique blob: URLs, exactly the way separate Supabase edge isolates each hold
// their own module state while sharing Redis. Deno.serve is captured so no
// port opens; the handler is what a request hits in production, including the
// access-log / request-id wrapper.
//
// Nothing in index.ts is modified — its source is read from disk and only the
// relative import specifiers are rewritten to absolute/blob URLs.

import { REDIS_TOKEN, REDIS_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from "./fakeSupabase.ts";

export interface EdgeIsolate {
  id: string;
  redis: boolean;
  handler: (request: Request) => Promise<Response>;
}

const API_DIR = new URL("../../", import.meta.url);

function moduleUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "application/typescript" }));
}

async function readApiModule(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, API_DIR));
}

function rewriteRelativeImports(source: string, overrides: Record<string, string>): string {
  return source.replace(/from\s+"\.\/([A-Za-z0-9_./-]+)"/g, (_match, rel: string) => {
    const override = overrides[`./${rel}`];
    return `from "${override ?? new URL(rel, API_DIR).href}"`;
  });
}

let envReady = false;

/** Env the edge fn reads at import time. Apple secrets are placeholders — the
 * exercised routes never reach the Apple grant exchange. */
function ensureEnv(): void {
  if (envReady) return;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY);
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "xc-rsm-service-role");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "xc-rsm-webhook-secret");
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", "");
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", "");
  envReady = true;
}

const sources: { cache?: string; rateLimit?: string; index?: string } = {};

export async function loadEdgeIsolate(
  id: string,
  options: { redis: boolean },
): Promise<EdgeIsolate> {
  ensureEnv();
  sources.cache ??= await readApiModule("cache.ts");
  sources.rateLimit ??= await readApiModule("rateLimit.ts");
  sources.index ??= await readApiModule("index.ts");

  // cache.ts reads the Upstash env at import time — set it only while this
  // isolate's copy is being evaluated.
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const cacheUrl = moduleUrl(`// isolate ${id}\n${sources.cache}`);
  await import(cacheUrl);
  const rateLimitUrl = moduleUrl(
    `// isolate ${id}\n${rewriteRelativeImports(sources.rateLimit, { "./cache.ts": cacheUrl })}`,
  );
  const indexUrl = moduleUrl(
    `// isolate ${id}\n${rewriteRelativeImports(sources.index, {
      "./cache.ts": cacheUrl,
      "./rateLimit.ts": rateLimitUrl,
    })}`,
  );

  const realServe = Deno.serve;
  let handler: ((request: Request) => Promise<Response>) | null = null;
  Deno.serve = ((...args: unknown[]) => {
    const found = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!found) throw new Error("Deno.serve called without a handler");
    handler = found;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;
  try {
    await import(indexUrl);
  } finally {
    Deno.serve = realServe;
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }
  if (!handler) throw new Error(`isolate ${id}: index.ts did not call Deno.serve`);
  return { id, redis: options.redis, handler };
}
