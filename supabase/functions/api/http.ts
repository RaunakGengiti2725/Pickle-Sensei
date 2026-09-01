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

/** Public legal documents (privacy/terms). Plain text on purpose: the
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

/**
 * Sanitize free-form user text before storing it: strips control characters
 * (C0/C1) and zero-width/bidi characters that enable spoofing, collapses
 * whitespace runs, trims, and caps the length. Rendering stays safe because
 * clients display via React Native <Text> (no HTML interpretation) and any
 * HTML surface must escape via escapeHtml — this strip is defense in depth,
 * not the only line.
 */
export function sanitizeUserText(value: string, maxLength: number): string {
  return (
    value
      // Stripping control characters is this function's purpose.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength)
  );
}

/** First client IP from the gateway's x-forwarded-for chain. Used only for
 * rate limiting — never stored. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
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
