import type { FastifyInstance } from "fastify";

/**
 * Browser-facing response hardening for a JSON-only API, mirroring the edge
 * function's `JSON_SECURITY_HEADERS` (supabase/functions/api/http.ts) so both
 * implementations present the same posture to a browser that reaches them.
 * Every response is `no-store` because every route is either per-user or a
 * live health/contract read.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
};

export const REQUEST_ID_HEADER = "x-request-id";

/** Opaque client trace token: 8–64 chars of [A-Za-z0-9._-]. Anything else is
 * replaced by a server-minted id so logs and response headers never carry
 * arbitrary client input. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function acceptableRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });
}
