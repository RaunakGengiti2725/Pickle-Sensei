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

// Stripping control characters is sanitizeUserText's purpose. U+200C ZWNJ and
// U+200D ZWJ are deliberately NOT in this class: they are format characters
// that Persian/Arabic, Indic scripts and emoji ZWJ sequences need to render
// correctly (only their context-free occurrences are dropped, below).
const CONTROL_AND_SPOOFING_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// A joiner only means something between two non-space characters; at the
// start/end of the text or beside whitespace it is invisible padding.
const CONTEXT_FREE_JOINERS = /(?:^|(?<=\s))[\u200c\u200d]+|[\u200c\u200d]+(?=\s|$)/g;
const TRAILING_JOINERS = /[\u200c\u200d]+$/;

/**
 * Sanitize free-form user text before storing it: strips control characters
 * (C0/C1 — whitespace ones normalise to a space instead), lone surrogates,
 * and zero-width/bidi characters that enable spoofing (keeping ZWNJ/ZWJ
 * inside words), collapses whitespace runs, trims, and caps the length in
 * code points (never splitting a surrogate pair or ending on a dangling
 * joiner; matches the DB's char_length caps). Rendering stays safe because
 * clients display via React Native <Text> (no HTML interpretation) and any
 * HTML surface must escape via escapeHtml — this strip is defense in depth,
 * not the only line.
 */
export function sanitizeUserText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(CONTROL_AND_SPOOFING_CHARS, "")
    .replace(LONE_SURROGATES, "")
    .replace(CONTEXT_FREE_JOINERS, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join("").replace(TRAILING_JOINERS, "").trimEnd();
}

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV4_WITH_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED_IPV6_RE = /^\[([0-9a-fA-F:.]{2,45})\](?::\d{1,5})?$/;
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/;
// Longest literal: bracketed IPv6 with embedded IPv4 and a port (53 chars).
const IP_LITERAL_MAX_CHARS = 64;

function parseIpv6(value: string): string | null {
  const lower = value.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(lower)) return null;
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string) => (half === "" ? [] : half.split(":"));
  const groups = [...groupsOf(halves[0]), ...(halves.length === 2 ? groupsOf(halves[1]) : [])];
  let units = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (group.includes(".")) {
      if (i !== groups.length - 1 || !IPV4_RE.test(group)) return null;
      units += 2;
    } else if (HEX_GROUP_RE.test(group)) {
      units += 1;
    } else {
      return null;
    }
  }
  if (halves.length === 2 ? units > 7 : units !== 8) return null;
  return lower;
}

/** The literal as a normalised IPv4/IPv6 address, or null when it is not
 * one. Accepts a proxy-appended port (`1.2.3.4:5678`, `[::1]:443`). */
function parseIpLiteral(raw: string): string | null {
  if (raw.length === 0 || raw.length > IP_LITERAL_MAX_CHARS) return null;
  const bracketed = BRACKETED_IPV6_RE.exec(raw);
  if (bracketed) return parseIpv6(bracketed[1]);
  const withPort = IPV4_WITH_PORT_RE.exec(raw);
  const candidate = withPort ? withPort[1] : raw;
  if (IPV4_RE.test(candidate)) return candidate;
  return parseIpv6(candidate);
}

// FNV-1a (64-bit) over at most the first 1 024 UTF-16 units: a cheap,
// synchronous, fixed-size bucket id for header material that is not an IP
// literal. Not a security digest — it only has to be deterministic and
// bounded so hostile bytes never become a key.
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;
const HASH_INPUT_MAX_UNITS = 1_024;
function fnv1a64(text: string): string {
  let hash = FNV64_OFFSET;
  const end = Math.min(text.length, HASH_INPUT_MAX_UNITS);
  for (let i = 0; i < end; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Client identity for rate limiting — never stored. Prefers the edge's
 * single trusted `cf-connecting-ip`; otherwise the LAST x-forwarded-for hop
 * (proxies append the peer they saw, so the leftmost entries are
 * client-controlled). Only a well-formed IPv4/IPv6 literal is used as-is
 * (normalised, port dropped). Header material that is present but not an IP
 * literal never becomes the identity verbatim: it is reduced to a bounded
 * `anon:<hash>` bucket, so it can neither grow rate-limit keys without bound
 * nor pool every such client into one shared budget. `unknown` is returned
 * only when no client-address header is present at all (direct invocation,
 * tests) — every gateway path supplies one. */
export function clientIp(request: Request): string {
  const candidates: string[] = [];
  const edgeIp = request.headers.get("cf-connecting-ip")?.trim();
  if (edgeIp) candidates.push(edgeIp);
  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (hops.length > 0) candidates.push(hops[hops.length - 1]);
  for (const candidate of candidates) {
    const ip = parseIpLiteral(candidate);
    if (ip) return ip;
  }
  if (candidates.length === 0) return "unknown";
  return `anon:${fnv1a64(candidates.join("|"))}`;
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
