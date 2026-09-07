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

const FAILURE_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DataError",
  "OperationError",
  "NetworkError",
  "AuthError",
  "AuthApiError",
  "AuthRetryableFetchError",
  "AuthUnknownError",
  "ExternalAccountError",
  "InvalidSessionResponse",
  "SessionCheckError",
  "ConfigurationError",
  "EmptyResult",
  "UnexpectedResult",
]);
const AUTH_FAILURE_CODES = new Set([
  "unexpected_failure",
  "request_timeout",
  "over_request_rate_limit",
  "over_email_send_rate_limit",
  "over_sms_send_rate_limit",
  "bad_jwt",
  "session_not_found",
  "session_expired",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "user_not_found",
  "user_banned",
]);
const EXTERNAL_FAILURE_KINDS = new Set([
  "configuration",
  "invalid_grant",
  "invalid_response",
  "unavailable",
]);

export function isSupabaseEndpointRequest(
  target: string,
  serviceUrl: string,
  endpoint: "auth" | "rest",
): boolean {
  try {
    if (endpoint !== "auth" && endpoint !== "rest") return false;
    const base = new URL(serviceUrl);
    const url = new URL(target);
    const prefix = `${base.pathname.replace(/\/+$/, "")}/${endpoint}/v1/`;
    return (
      (base.protocol === "https:" || base.protocol === "http:") &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.origin === base.origin &&
      url.pathname.startsWith(prefix) &&
      !/%(?:2f|5c|25)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function failureDetail(
  error?: unknown,
  status?: unknown,
): {
  name: string;
  code: string;
  status: number | null;
  kind?: string;
  provider?: string;
} {
  const fallback = { name: "unknown", code: "unknown", status: null };
  try {
    const detail =
      error !== null && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>)
        : {};
    const name = detail.name;
    const code = detail.code;
    const httpStatus = status ?? detail.status;
    const result: ReturnType<typeof failureDetail> = {
      name: typeof name === "string" && FAILURE_NAMES.has(name) ? name : "unknown",
      code:
        typeof code === "string" &&
        (/^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(code) || AUTH_FAILURE_CODES.has(code))
          ? code
          : "unknown",
      status:
        typeof httpStatus === "number" &&
        Number.isInteger(httpStatus) &&
        httpStatus >= 100 &&
        httpStatus <= 599
          ? httpStatus
          : null,
    };
    if (result.name === "ExternalAccountError") {
      const kind = detail.kind;
      const provider = detail.provider;
      if (typeof kind === "string" && EXTERNAL_FAILURE_KINDS.has(kind)) result.kind = kind;
      if (provider === "apple" || provider === "revenuecat") result.provider = provider;
    }
    return result;
  } catch {
    return fallback;
  }
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
