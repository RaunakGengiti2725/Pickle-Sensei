// HTTP hardening helpers: security headers, HTML escaping, user-text
// sanitization, client-IP extraction, and constant-time secret comparison.

/** Headers attached to every JSON API response. The API serves per-user
 * state, so responses are never cacheable by intermediaries. */
export const JSON_SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

/** Public support and legal documents. Plain text on purpose: the
 * Supabase functions gateway rewrites Content-Type to text/plain and forces
 * a sandbox CSP on *.supabase.co, so HTML would display as raw source. The
 * gateway layers its own nosniff/CSP on top of these headers. */
export function legalTextResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// Stripping control characters is sanitizeUserText's purpose.
const CONTROL_AND_SPOOFING_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Sanitize free-form user text before storing it: strips control characters
 * (C0/C1 — whitespace ones normalise to a space instead), lone surrogates,
 * and zero-width/bidi characters that enable spoofing, collapses whitespace
 * runs, trims, and caps the length in code points (never splitting a
 * surrogate pair; matches the DB's char_length caps). Rendering stays safe
 * because clients display via React Native <Text> (no HTML interpretation)
 * and any HTML surface must escape via escapeHtml — this strip is defense in
 * depth, not the only line.
 */
export function sanitizeUserText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(CONTROL_AND_SPOOFING_CHARS, "")
    .replace(LONE_SURROGATES, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join("").trimEnd();
}

/** Client IP for rate limiting — never stored. Prefers the edge's single
 * trusted `cf-connecting-ip`; otherwise the LAST x-forwarded-for hop (proxies
 * append the peer they saw, so the leftmost entries are client-controlled). */
export function clientIp(request: Request): string {
  const edgeIp = request.headers.get("cf-connecting-ip")?.trim();
  if (edgeIp) return edgeIp;
  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}

/** Constant-time string equality for webhook shared secrets. */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) {
    // Still burn comparable time on a same-length self-compare.
    let noise = 0;
    for (let i = 0; i < bufA.length; i += 1) noise |= bufA[i] ^ bufA[i];
    return noise === -1;
  }
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

/** Request-id contract: honour a well-formed client `x-request-id`
 * (opaque token, ≤ 64 chars of [A-Za-z0-9._-]) so a failure can be traced
 * from the client through the function logs; otherwise mint one. Never
 * echoes arbitrary client input. */
export const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
export function resolveRequestId(request: Request): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER)?.trim() ?? "";
  return REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
}

/** Route template for logs: UUIDs and long digit runs collapse to `:id` so
 * lines never carry a user, shot, or session identifier. */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_SEGMENT = /^\d{4,}$/;
export function routeTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      UUID_SEGMENT.test(segment) || DIGITS_SEGMENT.test(segment) ? ":id" : segment,
    )
    .join("/");
}

export interface AccessLogEntry {
  evt: "api_request";
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  code?: string;
}

/** One machine-readable line per request (stdout → Supabase function logs).
 * Categorical only: no user id, bearer, body, query string, or IP. */
export function accessLogEntry(
  request: Request,
  response: Response,
  requestId: string,
  startedAt: number,
  code?: string,
): AccessLogEntry {
  const entry: AccessLogEntry = {
    evt: "api_request",
    requestId,
    method: request.method,
    route: routeTemplate(new URL(request.url).pathname),
    status: response.status,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
  if (code) entry.code = code;
  return entry;
}

type AccessLogSink = (line: string) => void;
// Supabase Function logs capture console.* only (not raw stdout); this is the
// single structured, categorical line per request — not debug output.
// eslint-disable-next-line no-console
const printAccessLog: AccessLogSink = (line) => console.log(line);
let accessLogSink: AccessLogSink = printAccessLog;

export function emitAccessLog(entry: AccessLogEntry): void {
  accessLogSink(JSON.stringify(entry));
}

/** Tests/diagnostics: capture access lines instead of printing them. Returns
 * the restore function. */
export function captureAccessLog(sink: AccessLogSink): () => void {
  accessLogSink = sink;
  return () => {
    accessLogSink = printAccessLog;
  };
}

/** Copy of `response` carrying the request id header (Response headers may be
 * immutable; a fresh Response with the same body/status/headers is not). */
export function withRequestId(response: Response, requestId: string): Response {
  const out = new Response(response.body, response);
  out.headers.set(REQUEST_ID_HEADER, requestId);
  return out;
}

/** Extract `error.code` from an error body clone without consuming the
 * response the client receives. Returns undefined for non-JSON / no code. */
export async function errorCodeOf(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  try {
    const body = await response.clone().json();
    const code = body?.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}
