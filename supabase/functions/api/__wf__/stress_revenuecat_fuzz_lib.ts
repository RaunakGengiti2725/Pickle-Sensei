// Seeded fuzz/boundary library for POST /webhooks/revenuecat.
//
// Everything here is deterministic from a 32-bit seed: the request generator
// (method / path / query / headers / body), the fault plan for the stubbed
// backends, and the oracle that says which outcomes are acceptable. The
// stateful fake installed by `installFakeBackends` sits ON TOP of the
// routesHarness fetch stub and models what the real handler would see from
// PostgREST (webhook_events + billing_entitlements) and RevenueCat, including
// the Postgres behaviours verified against docker postgres:16 with every
// migration applied (see stress_revenuecat_fuzz_pg.test.ts):
//   - jsonb rejects U+0000 (22P05) and lone surrogates (22P02)
//   - a btree primary-key entry larger than 2704 bytes AFTER pglz compression
//     is refused (54000) — random hex fails at ~2690 bytes, "x"*3000 fits
//   - uuid columns compare case-insensitively (an upper-cased uuid hits the
//     same billing_entitlements row as its lower-cased form)
//   - billing_entitlements.user_id → profiles.id foreign key (23503)

export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_JSON_BODY_BYTES = 5_000_000;
export const BTREE_MAX_INDEX_ROW_BYTES = 2704;
export const REJECT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
export const GENERIC_5XX_MESSAGES = new Set([
  "Verification is temporarily unavailable.",
  "Webhook is not configured.",
  "Webhook processing is not configured.",
  "Something went wrong. Please try again.",
]);
/** Substrings that must never appear in a client-visible body. */
export const LEAK_TOKENS = [
  "index.ts",
  "routesHarness",
  "    at ",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "PGRST",
  "webhook_events",
  "billing_entitlements",
  "postgrest",
  "PostgREST",
  "supabase",
  "service-role-test-key",
  "sk_test_revenuecat",
  "wf-test-webhook-secret",
  "22P05",
  "23503",
  "54000",
  "constraint",
  "internal error stub",
];

// ─────────────────────────────────────────────────────────────────────────────
// PRNG (mulberry32) — identical algorithm to xc_concurrency_harness.Prng so a
// seed printed by either harness means the same stream.
// ─────────────────────────────────────────────────────────────────────────────

export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  hex(n: number): string {
    return Array.from({ length: n }, () => this.int(0, 15).toString(16)).join("");
  }
}

/** Per-iteration seed derived from the campaign seed (splitmix-style hash). */
export function iterationSeed(campaignSeed: number, index: number): number {
  let x = (campaignSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hostile string alphabet
// ─────────────────────────────────────────────────────────────────────────────

const ODD_STRINGS: readonly string[] = [
  "",
  " ",
  "\t\n\r",
  "null",
  "undefined",
  "true",
  "0",
  "-1",
  "1e308",
  "NaN",
  "__proto__",
  "constructor",
  "prototype",
  "eq.x",
  "in.(a,b)",
  "or(id.eq.x)",
  "id=eq.x&select=*",
  "*",
  "%",
  "%00",
  "%2F",
  "..",
  "../../",
  "' or 1=1 --",
  '" or ""="',
  "; drop table webhook_events; --",
  "$RCAnonymousID:8f3a6bd7e1c24a5c9d1e2f3a4b5c6d7e",
  "{{7*7}}",
  "${7*7}",
  "<script>alert(1)</script>",
  "\u202e\u0644\u0627",
  "\u200b\u200c\u200d\ufeff",
  "ﬃ",
  "İ",
  "ß",
  "😀🏓",
  "日本語のテキスト",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
  "a\u0300\u0301\u0302",
];

export function hostileString(prng: Prng): string {
  const mode = prng.int(0, 9);
  switch (mode) {
    case 0:
    case 1:
      return prng.pick(ODD_STRINGS);
    case 2:
      return prng.hex(prng.int(1, 64));
    case 3:
      // control characters incl. NUL
      return Array.from({ length: prng.int(1, 6) }, () => String.fromCharCode(prng.int(0, 31)))
        .join("")
        .concat(prng.hex(4));
    case 4:
      return `${prng.hex(6)}\u0000${prng.hex(6)}`;
    case 5:
      // lone surrogate
      return `${prng.hex(4)}${String.fromCharCode(0xd800 + prng.int(0, 0x3ff))}${prng.hex(4)}`;
    case 6:
      // long incompressible (may exceed the btree PK ceiling)
      return prng.hex(prng.int(1000, 6000));
    case 7:
      // long compressible
      return "a".repeat(prng.int(1000, 200_000));
    case 8:
      return prng.uuid().toUpperCase();
    default:
      return Array.from({ length: prng.int(1, 12) }, () =>
        String.fromCodePoint(prng.int(0x20, 0x2ffff)),
      ).join("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event / body generators
// ─────────────────────────────────────────────────────────────────────────────

export const RC_EVENT_TYPES = [
  "INITIAL_PURCHASE",
  "RENEWAL",
  "CANCELLATION",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_PAUSED",
  "EXPIRATION",
  "BILLING_ISSUE",
  "PRODUCT_CHANGE",
  "TRANSFER",
  "SUBSCRIBER_ALIAS",
  "TEST",
] as const;

export interface SubjectPlan {
  /** Canonical (lower-case) user ids the REAL handler should end up verifying. */
  canonical: string[];
  /** RevenueCat app_user_id strings the handler will actually query (case-preserved). */
  rcIds: string[];
}

/** Compute exactly the subject set the production handler derives (index.ts
 * handleRevenueCatWebhook): app_user_id if uuid, else first uuid alias; plus
 * every uuid in transferred_from / transferred_to; Set-deduped, case kept. */
export function expectedSubjects(event: Record<string, unknown>): SubjectPlan {
  const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
  const uuidList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isUuid) : []);
  const set = new Set<string>();
  if (isUuid(event.app_user_id)) set.add(event.app_user_id);
  else {
    const alias = uuidList(event.aliases)[0];
    if (alias) set.add(alias);
  }
  for (const id of uuidList(event.transferred_from)) set.add(id);
  for (const id of uuidList(event.transferred_to)) set.add(id);
  const rcIds = [...set];
  return { rcIds, canonical: [...new Set(rcIds.map((id) => id.toLowerCase()))] };
}

export type BodyKind =
  | "valid_event"
  | "hostile_event"
  | "missing_event"
  | "event_not_object"
  | "not_object_json"
  | "malformed_json"
  | "empty"
  | "binary";

export interface GeneratedBody {
  kind: BodyKind;
  raw: string | Uint8Array;
  /** Parsed event when the handler should see one (mirrors readBody). */
  event: Record<string, unknown> | null;
  parsed: Record<string, unknown> | null;
  note: string;
}

function realisticEvent(prng: Prng, userId: string): Record<string, unknown> {
  const type = prng.pick(RC_EVENT_TYPES);
  const event: Record<string, unknown> = {
    id: prng.uuid().toUpperCase().replace(/-/g, ""),
    type,
    app_user_id: userId,
    original_app_user_id: userId,
    aliases: [userId, `$RCAnonymousID:${prng.hex(32)}`],
    product_id: prng.pick([
      "pickle_sensei_pro_monthly",
      "pickle_sensei_pro_yearly",
      "pickle_sensei_pro_lifetime",
    ]),
    entitlement_ids: ["pickle_sensei_pro"],
    period_type: prng.pick(["NORMAL", "TRIAL", "INTRO"]),
    purchased_at_ms: Date.now() - prng.int(0, 86_400_000),
    expiration_at_ms: Date.now() + prng.int(-86_400_000, 86_400_000 * 30),
    environment: prng.pick(["PRODUCTION", "SANDBOX"]),
    store: "APP_STORE",
    event_timestamp_ms: Date.now(),
    subscriber_attributes: {
      $email: { value: "user@example.com", updated_at_ms: Date.now() },
    },
  };
  if (type === "TRANSFER") {
    delete event.app_user_id;
    event.transferred_from = [prng.uuid(), `$RCAnonymousID:${prng.hex(32)}`];
    event.transferred_to = [userId];
  }
  return event;
}

function hostileEvent(prng: Prng, userId: string): { event: Record<string, unknown>; note: string } {
  const event = realisticEvent(prng, userId);
  const notes: string[] = [];
  const mutations = prng.int(1, 3);
  for (let m = 0; m < mutations; m++) {
    const which = prng.int(0, 11);
    switch (which) {
      case 0:
        event.id = hostileString(prng);
        notes.push("id=hostile");
        break;
      case 1:
        event.id = prng.pick([null, 42, 1e308, true, {}, [], ["x"], { $ne: null }]);
        notes.push("id=non-string");
        break;
      case 2:
        event.type = hostileString(prng);
        notes.push("type=hostile");
        break;
      case 3:
        event.type = prng.pick([null, 7, [], {}, false]);
        notes.push("type=non-string");
        break;
      case 4:
        event.app_user_id = prng.pick([
          userId.toUpperCase(),
          `{${userId}}`,
          `urn:uuid:${userId}`,
          userId.replace(/-/g, ""),
          `${userId} `,
          `${userId}\u0000`,
          "$RCAnonymousID:" + prng.hex(32),
          "00000000-0000-0000-0000-000000000000",
          "ffffffff-ffff-ffff-ffff-ffffffffffff",
          `${userId.slice(0, 14)}9${userId.slice(15)}`,
          hostileString(prng),
          123,
          null,
          [userId],
          { id: userId },
        ]);
        notes.push("app_user_id=variant");
        break;
      case 5:
        event.aliases = prng.pick([
          null,
          "not-an-array",
          [],
          [null, 1, {}, [], userId.toUpperCase()],
          Array.from({ length: prng.int(2, 40) }, () => prng.uuid()),
          [hostileString(prng), userId],
          { 0: userId },
        ]);
        notes.push("aliases=variant");
        break;
      case 6:
        event.transferred_from = prng.pick([
          null,
          userId,
          [userId, userId.toUpperCase()],
          Array.from({ length: prng.int(1, 60) }, () => prng.uuid()),
          [hostileString(prng)],
        ]);
        notes.push("transferred_from=variant");
        break;
      case 7:
        event.transferred_to = prng.pick([
          null,
          [userId],
          [userId.toUpperCase(), userId],
          Array.from({ length: prng.int(1, 60) }, () => prng.uuid()),
          [{}, [], 0, userId],
        ]);
        notes.push("transferred_to=variant");
        break;
      case 8:
        Object.defineProperty(event, "__proto__", { value: { premium: true }, enumerable: true, configurable: true, writable: true });
        Object.defineProperty(event, "constructor", { value: { prototype: { premium: true } }, enumerable: true, configurable: true, writable: true });
        notes.push("proto-keys");
        break;
      case 9:
        // Forged entitlement claims — must never influence the stored state.
        event.entitlement_ids = ["pickle_sensei_pro", "premium"];
        event.type = "INITIAL_PURCHASE";
        event.premium = true;
        event.expiration_at_ms = Date.now() + 10 * 365 * 86_400_000;
        event.entitlements = {
          pickle_sensei_pro: { expires_date: null, product_identifier: "pickle_sensei_pro_lifetime" },
        };
        notes.push("forged-entitlement-claims");
        break;
      case 10: {
        let deep: unknown = "leaf";
        for (let d = 0; d < prng.int(50, 400); d++) deep = { d: deep };
        event.subscriber_attributes = deep;
        notes.push("deep-nesting");
        break;
      }
      default:
        for (let k = 0; k < prng.int(1, 30); k++) {
          event[hostileString(prng).slice(0, 200) || `k${k}`] = hostileString(prng).slice(0, 2000);
        }
        notes.push("junk-keys");
    }
  }
  return { event, note: notes.join("+") };
}

/** Mirror of the handler's readBody: bytes on the wire → TextDecoder (which
 * consumes a leading BOM) → JSON.parse; non-object JSON and parse errors → {}. */
export function modelReadBody(raw: string | Uint8Array): Record<string, unknown> {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function generateBody(prng: Prng, userId: string): GeneratedBody {
  const roll = prng.next();
  const finish = (kind: BodyKind, raw: string | Uint8Array, note: string): GeneratedBody => {
    const parsed = modelReadBody(raw);
    const event = isRecord(parsed.event) ? parsed.event : null;
    return { kind, raw, event, parsed: Object.keys(parsed).length ? parsed : null, note };
  };
  if (roll < 0.3) {
    return finish(
      "valid_event",
      JSON.stringify({ api_version: "1.0", event: realisticEvent(prng, userId) }),
      "realistic",
    );
  }
  if (roll < 0.62) {
    const { event, note } = hostileEvent(prng, userId);
    const wrapper: Record<string, unknown> = { api_version: "1.0", event };
    if (prng.chance(0.2)) wrapper[hostileString(prng).slice(0, 100) || "x"] = hostileString(prng);
    return finish("hostile_event", JSON.stringify(wrapper), note);
  }
  if (roll < 0.72) {
    const wrapper = prng.pick<Record<string, unknown>>([
      {},
      { api_version: "1.0" },
      { events: [realisticEvent(prng, userId)] },
      { Event: realisticEvent(prng, userId) },
      { event: undefined },
      { api_version: "1.0", event: null },
    ]);
    return finish("missing_event", JSON.stringify(wrapper), "no event key");
  }
  if (roll < 0.8) {
    const ev = prng.pick<unknown>([
      "INITIAL_PURCHASE",
      42,
      true,
      [realisticEvent(prng, userId)],
      [],
      "",
      JSON.stringify(realisticEvent(prng, userId)),
    ]);
    return finish("event_not_object", JSON.stringify({ event: ev }), "event is not an object");
  }
  if (roll < 0.87) {
    const raw = prng.pick([
      "[]",
      `[${JSON.stringify(realisticEvent(prng, userId))}]`,
      "null",
      "true",
      "0",
      '"event"',
      "1e400",
      "-0",
    ]);
    return finish("not_object_json", raw, "top-level JSON not an object");
  }
  if (roll < 0.95) {
    const good = JSON.stringify({ api_version: "1.0", event: realisticEvent(prng, userId) });
    const raw = prng.pick([
      good.slice(0, prng.int(0, good.length - 1)),
      good + good,
      good.replace(/"/g, "'"),
      "{event:{}}",
      "{'event':{}}",
      "{\"event\":{\"id\":\"x\",}}",
      "\ufeff" + good,
      good + "\u0000",
      "<xml><event/></xml>",
      "event=INITIAL_PURCHASE&app_user_id=" + userId,
      "{\"event\":{\"id\":\"" + "\\u" + "d800\"}}",
      "{\"event\":{\"a\":" + "[".repeat(5000) + "]".repeat(5000) + "}}",
      "{\"event\":{\"a\":" + "[".repeat(200000) + "}}",
    ]);
    return finish("malformed_json", raw, "malformed JSON");
  }
  if (roll < 0.98) {
    return finish("empty", "", "empty body");
  }
  const bytes = new Uint8Array(prng.int(1, 4096));
  for (let i = 0; i < bytes.length; i++) bytes[i] = prng.int(0, 255);
  return finish("binary", bytes, "random bytes");
}

// ─────────────────────────────────────────────────────────────────────────────
// Request-level generators: auth, headers, method/path/query
// ─────────────────────────────────────────────────────────────────────────────

/** Header values must be ByteStrings without CR/LF/NUL — keep printable
 * ASCII plus obs-text (0x80–0xFF) so the Request constructor accepts them. */
export function headerSafe(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff)) out += ch;
    else if (code > 0xff) out += String.fromCharCode(0x80 + (code % 0x7f));
  }
  return out;
}

export interface AuthPlan {
  header: string | null;
  valid: boolean;
  note: string;
}

export function generateAuth(prng: Prng, secret: string, forceValid = false): AuthPlan {
  if (forceValid || prng.chance(0.7)) return { header: secret, valid: true, note: "valid" };
  const variant = prng.int(0, 13);
  switch (variant) {
    case 0:
      return { header: null, valid: false, note: "missing" };
    case 1:
      return { header: "", valid: false, note: "empty" };
    case 2:
      return { header: `Bearer ${secret}`, valid: false, note: "bearer-prefixed" };
    case 3:
      return { header: secret.toUpperCase(), valid: false, note: "upper-cased" };
    case 4:
      return { header: `${secret} `, valid: false, note: "trailing-space" };
    case 5:
      return { header: secret.slice(0, -1), valid: false, note: "truncated" };
    case 6:
      return { header: `${secret}\u00a0`, valid: false, note: "nbsp-suffixed" };
    case 7:
      return { header: secret.repeat(2), valid: false, note: "doubled" };
    case 8:
      return { header: "x".repeat(prng.int(1, 8192)), valid: false, note: "long-junk" };
    case 9:
      return { header: `Basic ${btoa(`rc:${secret}`)}`, valid: false, note: "basic" };
    case 10:
      return { header: prng.hex(prng.int(1, 64)), valid: false, note: "random-hex" };
    case 11:
      return {
        header: secret.slice(0, prng.int(1, secret.length - 1)) + "\u200b" + secret.slice(prng.int(1, secret.length - 1)),
        valid: false,
        note: "zero-width-injected",
      };
    case 12:
      return { header: headerSafe(hostileString(prng)) || "z", valid: false, note: "hostile" };
    default:
      return { header: `${secret}=`, valid: false, note: "suffix" };
  }
}

export interface RouteTarget {
  method: string;
  path: string;
  query: string;
  /** Whether the REAL dispatcher would reach handleRevenueCatWebhook. */
  reachesWebhook: boolean;
  note: string;
}

const WEBHOOK_PATH = "/functions/v1/api/webhooks/revenuecat";

export function generateRoute(prng: Prng): RouteTarget {
  const roll = prng.next();
  let method = "POST";
  let path = WEBHOOK_PATH;
  let query = "";
  const notes: string[] = [];
  if (roll >= 0.85) {
    method = prng.pick(["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "post", "PoSt", "PROPFIND", "WEBHOOK"]);
    notes.push(`method=${method}`);
  }
  if (prng.chance(0.15)) {
    path = prng.pick([
      "/webhooks/revenuecat",
      "/api/webhooks/revenuecat",
      "/functions/v1/api/webhooks/revenuecat/",
      "/functions/v1/api/webhooks/REVENUECAT",
      "/functions/v1/api/webhooks/revenuecat%2F",
      "/functions/v1/api/webhooks//revenuecat",
      "/functions/v1/api/../api/webhooks/revenuecat",
      "/functions/v1/api/webhooks/revenuecat%00",
      "/functions/v1/api/v1/webhooks/revenuecat",
      "/functions/v1/api/webhooks/revenuecat.",
      "/functions/v1/api/webhooks/revenuecat;x=1",
      `/${prng.hex(32)}/webhooks/revenuecat`,
      "/functions/v1/api/webhooks/revenuecats",
      "/functions/v1/api/webhooks/revenuecat%20",
      "//webhooks/revenuecat",
    ]);
    notes.push(`path=${path}`);
  }
  if (prng.chance(0.2)) {
    query = prng.pick([
      "?event=INITIAL_PURCHASE",
      "?id=eq.x",
      "?" + "a=" + "b".repeat(prng.int(1, 20000)),
      "?%00",
      "?event[id]=x&event[type]=y",
      "?" + encodeURIComponent(hostileString(prng).slice(0, 500).toWellFormed()),
      "?__proto__[x]=1",
      "#fragment",
    ]);
    notes.push("query");
  }
  // The real dispatcher: POST (after Request normalisation) + pathname suffix
  // "/webhooks/revenuecat". Query/fragment never affect pathname.
  let pathname: string;
  try {
    pathname = new URL(`http://edge.test${path}${query}`).pathname;
  } catch {
    pathname = path;
  }
  const normalizedMethod = /^(post)$/i.test(method) ? "POST" : method;
  const reachesWebhook = normalizedMethod === "POST" && pathname.endsWith("/webhooks/revenuecat");
  return { method, path, query, reachesWebhook, note: notes.join("+") || "canonical" };
}

export interface HeaderPlan {
  headers: Record<string, string>;
  /** Value the response x-request-id must equal, or null when a fresh uuid is expected. */
  expectRequestId: string | null;
  note: string;
}

export function generateHeaders(prng: Prng, ip: string): HeaderPlan {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  const notes: string[] = [];
  const ctRoll = prng.next();
  if (ctRoll < 0.7) headers["content-type"] = "application/json";
  else if (ctRoll < 0.8) headers["content-type"] = "application/json; charset=utf-8";
  else if (ctRoll < 0.9) {
    headers["content-type"] = prng.pick([
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/octet-stream",
      "application/json; boundary=x",
      "application/xml",
      "",
    ]);
    notes.push("content-type=odd");
  } else notes.push("content-type=absent");

  let expectRequestId: string | null = null;
  if (prng.chance(0.5)) {
    const validId = prng.pick([
      prng.hex(prng.int(8, 64)),
      `req_${prng.hex(12)}`,
      `a.b-c_d${prng.hex(8)}`,
      "A".repeat(64),
      "12345678",
    ]);
    if (prng.chance(0.6)) {
      headers["x-request-id"] = prng.chance(0.2) ? ` ${validId} ` : validId;
      expectRequestId = validId;
      notes.push("request-id=valid");
    } else {
      headers["x-request-id"] = prng.pick([
        "",
        "short",
        "A".repeat(65),
        "has space inside",
        `${prng.hex(16)}/../x`,
        "r\u00e9quest-id-0001",
        `${prng.hex(8)};drop`,
        "x".repeat(10_000),
        "%0d%0aX-Injected:1",
        "\t" + prng.hex(12),
      ]);
      notes.push("request-id=invalid");
    }
  }
  if (prng.chance(0.1)) {
    headers["x-forwarded-for"] = prng.pick([
      `1.1.1.1, 2.2.2.2, ${ip}`,
      `${ip},`,
      "",
      ", , ,",
      "not-an-ip",
      "x".repeat(4096),
      `${ip}\t`,
    ]);
    notes.push("xff=odd");
  }
  if (prng.chance(0.08)) {
    headers["cf-connecting-ip"] = ip;
    notes.push("cf-ip");
  }
  if (prng.chance(0.15)) {
    headers["content-length"] = prng.pick([
      "0",
      "1",
      "-1",
      "abc",
      "Infinity",
      "NaN",
      "1e9",
      String(MAX_JSON_BODY_BYTES),
      String(MAX_JSON_BODY_BYTES + 1),
      "99999999999999999999",
      "0x10",
      " 12 ",
    ]);
    notes.push(`content-length=${headers["content-length"]}`);
  }
  if (prng.chance(0.1)) {
    for (let k = 0; k < prng.int(1, 5); k++) {
      const name = `x-fuzz-${prng.hex(4)}`;
      headers[name] = headerSafe(hostileString(prng)).slice(0, 2000) || "v";
    }
    notes.push("junk-headers");
  }
  return { headers, expectRequestId, note: notes.join("+") || "plain" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stateful fake backends (PostgREST + RevenueCat), layered over the harness
// ─────────────────────────────────────────────────────────────────────────────

export type RcMode = "ok" | "http500" | "http429" | "http404" | "nonjson" | "nosubscriber" | "throw";

export interface FaultPlan {
  rc: RcMode;
  /** Subjects (RC ids) after which RC fails; -1 = never. */
  rcFailAfter: number;
  lookupFail: boolean;
  logFail: boolean;
  billingFail: boolean;
}

export const NO_FAULTS: FaultPlan = {
  rc: "ok",
  rcFailAfter: -1,
  lookupFail: false,
  logFail: false,
  billingFail: false,
};

export function generateFaults(prng: Prng): FaultPlan {
  if (prng.chance(0.75)) return { ...NO_FAULTS };
  const rc = prng.pick<RcMode>(["ok", "http500", "http429", "http404", "nonjson", "nosubscriber", "throw"]);
  return {
    rc,
    rcFailAfter: rc === "ok" ? -1 : prng.int(0, 2),
    lookupFail: prng.chance(0.3),
    logFail: prng.chance(0.3),
    billingFail: prng.chance(0.3),
  };
}

export interface BillingRow {
  user_id: string;
  premium: boolean;
  product_key: string | null;
  expires_at: string | null;
  verified_at: string;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  event_type: string | null;
  app_user_id: string | null;
  payload: unknown;
}

export interface Counters {
  rcCalls: number;
  lookups: number;
  eventUpserts: number;
  billingUpserts: number;
  writes: number;
  pgErrors: string[];
  rcIds: string[];
}

export interface FakeBackends {
  webhookEvents: Map<string, WebhookEventRow>;
  billing: Map<string, BillingRow>;
  profiles: Set<string>;
  /** RC truth per case-sensitive app_user_id; absent → RC auto-creates a free subscriber. */
  rcTruth: Map<string, { premium: boolean; expiresAt: string | null; product: string }>;
  faults: FaultPlan;
  counters: Counters;
  resetCounters(): void;
  uninstall(): void;
}

const newCounters = (): Counters => ({
  rcCalls: 0,
  lookups: 0,
  eventUpserts: 0,
  billingUpserts: 0,
  writes: 0,
  pgErrors: [],
  rcIds: [],
});

const pgError = (status: number, code: string, message: string, details: string | null = null): Response =>
  new Response(JSON.stringify({ code, message, details, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Postgres rejects U+0000 (22P05 "unsupported Unicode escape sequence") and
 * lone surrogates (22P02 "invalid input syntax for type json") anywhere in a
 * JSON document it has to convert — both verified on postgres:16. */
export function pgRejectsText(value: string): string | null {
  if (value.includes("\u0000")) return "22P05";
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) return "22P02";
  return null;
}

/** Rough pglz (PG's in-line TOAST compressor): greedy LZ77, 4-byte minimum
 * match, 4 KB window, 273-byte maximum match, 1 control bit per item; PG only
 * keeps the compressed form when it saves ≥ 25 %. Calibrated against
 * postgres:16 (see stress_revenuecat_fuzz_pg.test.ts PG-D): random hex /
 * alphanumerics do not compress, repeated words do. */
export function pglzEstimate(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n < 32) return n;
  const table = new Map<number, number>();
  let out = 0;
  let items = 0;
  let i = 0;
  while (i < n) {
    let best = 0;
    if (i + 4 <= n) {
      const key = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
      const cand = table.get(key);
      if (cand !== undefined && i - cand <= 4096) {
        let len = 0;
        while (len < 273 && i + len < n && bytes[cand + len] === bytes[i + len]) len++;
        if (len >= 4) best = len;
      }
      table.set(key, i);
    }
    if (best >= 4) {
      out += best > 17 ? 3 : 2;
      i += best;
    } else {
      out += 1;
      i += 1;
    }
    items += 1;
  }
  const compressed = out + Math.ceil(items / 8);
  return compressed < n * 0.75 ? compressed : n;
}

/** Would `id` overflow webhook_events_pkey (btree v4, 2704-byte tuple cap:
 * 8-byte tuple header + 4-byte varlena header + payload, possibly pglz'd)? */
export function pgIndexRowTooLarge(id: string): boolean {
  const raw = new TextEncoder().encode(id);
  if (raw.byteLength + 12 <= BTREE_MAX_INDEX_ROW_BYTES) return false;
  return pglzEstimate(raw) + 12 > BTREE_MAX_INDEX_ROW_BYTES;
}

/** Same check on a JSON document as PostgREST would forward it: JSON.stringify
 * escapes NUL as `\u0000` and (well-formed stringify) a LONE surrogate as
 * `\udXXX`, while paired surrogates are emitted raw. */
export function pgRejectsJson(value: unknown): string | null {
  const text = JSON.stringify(value) ?? "";
  if (/\\u0000/i.test(text)) return "22P05";
  if (/\\u[dD][89abAB][0-9a-fA-F]{2}/.test(text)) return "22P02";
  return null;
}

export function installFakeBackends(): FakeBackends {
  const base = globalThis.fetch;
  const state: FakeBackends = {
    webhookEvents: new Map(),
    billing: new Map(),
    profiles: new Set(),
    rcTruth: new Map(),
    faults: { ...NO_FAULTS },
    counters: newCounters(),
    resetCounters() {
      state.counters = newCounters();
    },
    uninstall() {
      globalThis.fetch = base;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const c = state.counters;

    if (url.hostname === "api.revenuecat.com") {
      c.rcCalls += 1;
      const rcId = decodeURIComponent(url.pathname.slice("/v1/subscribers/".length));
      c.rcIds.push(rcId);
      const f = state.faults;
      const failing = f.rc !== "ok" && (f.rcFailAfter < 0 || c.rcCalls > f.rcFailAfter);
      if (failing) {
        switch (f.rc) {
          case "http500":
            return new Response("upstream error", { status: 500 });
          case "http429":
            return new Response(JSON.stringify({ code: 7000, message: "rate limited" }), {
              status: 429,
              headers: { "Retry-After": "30" },
            });
          case "http404":
            return new Response(JSON.stringify({ code: 7259, message: "not found" }), { status: 404 });
          case "nonjson":
            return new Response("<html>gateway</html>", { status: 200 });
          case "nosubscriber":
            return new Response(JSON.stringify({ request_date_ms: Date.now() }), { status: 200 });
          case "throw":
            throw new TypeError("network failure (stub)");
        }
      }
      const truth = state.rcTruth.get(rcId);
      const entitlements: Record<string, unknown> = {};
      if (truth?.premium) {
        entitlements.pickle_sensei_pro = {
          expires_date: truth.expiresAt,
          product_identifier: truth.product,
          purchase_date: new Date(Date.now() - 1000).toISOString(),
        };
      }
      return new Response(
        JSON.stringify({
          request_date_ms: Date.now(),
          subscriber: {
            original_app_user_id: rcId,
            entitlements,
            subscriptions: {},
            non_subscriptions: {},
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length);
      const method = request.method;
      const prefer = request.headers.get("prefer") ?? "";
      const accept = request.headers.get("accept") ?? "";
      const bodyText = await request.text().catch(() => "");
      let body: unknown = null;
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = bodyText;
      }

      if (table === "webhook_events" && method === "GET") {
        c.lookups += 1;
        if (state.faults.lookupFail) {
          c.pgErrors.push("lookup:XX000");
          return pgError(500, "XX000", "internal error stub");
        }
        const filter = url.searchParams.get("id") ?? "";
        const wanted = filter.startsWith("eq.") ? filter.slice(3) : null;
        const rows = wanted !== null && state.webhookEvents.has(wanted) ? [{ id: wanted }] : [];
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length === 0) return pgError(406, "PGRST116", "0 rows");
          return new Response(JSON.stringify(rows[0]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (table === "webhook_events" && method === "POST") {
        c.eventUpserts += 1;
        c.writes += 1;
        if (state.faults.logFail) {
          c.pgErrors.push("log:XX000");
          return pgError(500, "XX000", "internal error stub");
        }
        const rows = (Array.isArray(body) ? body : [body]) as WebhookEventRow[];
        for (const row of rows) {
          const bad = pgRejectsJson(row);
          if (bad) {
            c.pgErrors.push(`log:${bad}`);
            return bad === "22P05"
              ? pgError(400, bad, "unsupported Unicode escape sequence", "\\u0000 cannot be converted to text.")
              : pgError(400, bad, "invalid input syntax for type json", "Unicode low surrogate must follow a high surrogate.");
          }
          if (typeof row.id !== "string") {
            c.pgErrors.push("log:22P02");
            return pgError(400, "22P02", "invalid input syntax");
          }
          if (pgIndexRowTooLarge(row.id)) {
            c.pgErrors.push("log:54000");
            return pgError(400, "54000", `index row size exceeds btree version 4 maximum ${BTREE_MAX_INDEX_ROW_BYTES}`);
          }
          const ignoreDuplicates = prefer.includes("resolution=ignore-duplicates");
          if (state.webhookEvents.has(row.id)) {
            if (!ignoreDuplicates) state.webhookEvents.set(row.id, row);
          } else {
            state.webhookEvents.set(row.id, row);
          }
        }
        return new Response(null, { status: 201 });
      }

      if (table === "billing_entitlements" && method === "POST") {
        c.billingUpserts += 1;
        c.writes += 1;
        if (state.faults.billingFail) {
          c.pgErrors.push("billing:XX000");
          return pgError(500, "XX000", "internal error stub");
        }
        const rows = (Array.isArray(body) ? body : [body]) as BillingRow[];
        for (const row of rows) {
          if (typeof row.user_id !== "string" || !UUID_RE.test(row.user_id)) {
            c.pgErrors.push("billing:22P02");
            return pgError(400, "22P02", "invalid input syntax for type uuid");
          }
          const key = row.user_id.toLowerCase();
          if (!state.profiles.has(key)) {
            c.pgErrors.push("billing:23503");
            return pgError(
              409,
              "23503",
              'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
            );
          }
          state.billing.set(key, { ...row, user_id: key });
        }
        return new Response(null, { status: 201 });
      }

      // Any other PostgREST traffic from this route is unexpected → surface it
      // loudly so a new write path cannot slip past the "no write" oracle.
      if (method !== "GET") c.writes += 1;
      c.pgErrors.push(`unexpected:${method}:${table}`);
      return pgError(500, "XX000", `unexpected ${method} ${table}`);
    }

    return base(input, init);
  }) as typeof fetch;

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response inspection
// ─────────────────────────────────────────────────────────────────────────────

export interface Inspected {
  status: number;
  requestId: string | null;
  contentType: string | null;
  text: string;
  json: Record<string, unknown> | null;
  leaks: string[];
}

export async function inspect(response: Response): Promise<Inspected> {
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    json = isRecord(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  const leaks = LEAK_TOKENS.filter((token) => text.includes(token));
  if (/\n\s+at\s+\S+:\d+:\d+/.test(text)) leaks.push("stack-frame");
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    text,
    json,
    leaks,
  };
}

export const errorMessageOf = (body: Record<string, unknown> | null): string | null => {
  const error = body && isRecord(body.error) ? body.error : null;
  return error && typeof error.message === "string" ? error.message : null;
};
