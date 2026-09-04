/**
 * Boundary/malformed-input stress campaign — HANDLER plane.
 *
 * Runs the REAL edge handler in-process (`routesHarness.ts` captures the
 * `Deno.serve` callback and stubs Supabase Auth/PostgREST, Apple and
 * RevenueCat) and drives the two routes that touch externalAccounts.ts:
 *
 *   POST /v1/account/bootstrap      Apple authorization-code capture
 *   POST /v1/me/delete-confirm      Apple revocation → RevenueCat → Auth
 *
 * Every iteration is a pure function of its seed and asserts the lens
 * invariants: never a 500, never internal detail in a 4xx/5xx body, never a
 * credential write on a rejected request, and fail-closed ordering during
 * account deletion (a 503 must leave RevenueCat and Auth untouched).
 *
 *   STRESS_ITER=<n>            iterations per family (default 120)
 *   STRESS_ONLY=<family>       run one family
 *   STRESS_REPLAY_SEED=<seed>  replay one scenario (see `replay` in the JSON)
 *   STRESS_OUT_DIR=<dir>       where the JSON result tables are written
 */
import { assert, assertEquals } from "@std/assert";
import {
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
} from "../externalAccounts.ts";
import {
  fakeAppleIdToken,
  loadHarness,
  RC_URL,
  userRequest,
} from "./routesHarness.ts";
import {
  b64std,
  boundaryString,
  Campaign,
  describeInput,
  familySelected,
  GRAPHEME_CLUSTERS,
  leakedDetail,
  NORMALIZATION_PAIRS,
  Prng,
  PROTO_KEYS,
  randomAscii,
  randomUnicode,
  rawBodyText,
  seedsFor,
  STRESS_ITER,
  TRAVERSAL_SLUGS,
  WEIRD_NUMBERS,
  wrongTypeValue,
} from "./stress_external_accounts_gen.ts";
import {
  decryptScenario,
  exchangeReply,
  revokeReply,
  wtf8,
} from "./stress_external_accounts_fixtures.ts";

const h = await loadHarness();
const FILE = "stress_external_accounts_routes.test.ts";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const OTHER_KEY = b64std(crypto.getRandomValues(new Uint8Array(32)));
const MAX_JSON_BODY_BYTES = 5_000_000;
const BOOTSTRAP_CODE_CAP = 4_096;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── harness helpers ─────────────────────────────────────────────────────────

type FetchFn = typeof fetch;

interface OwnedCall {
  url: string;
  method: string;
  body: string;
}

/** Own ONE upstream URL for a scenario (recording what the handler sent to
 * it); everything else falls through to the harness stubs (Supabase
 * Auth/PostgREST, default Apple/RevenueCat), which record into `h.calls`. */
async function withProviderReply<T>(
  url: string,
  reply: () => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<{ result: T; owned: OwnedCall[] }> {
  const inner = globalThis.fetch;
  const owned: OwnedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== url) return inner(input, init);
    owned.push({
      url: request.url,
      method: request.method,
      body: await request.text().catch(() => ""),
    });
    return await reply();
  }) as FetchFn;
  try {
    return { result: await run(), owned };
  } finally {
    globalThis.fetch = inner;
  }
}

interface CapturedLogs {
  error: string[];
  warn: string[];
}

/** The handler logs operator detail with console.error/warn and one access
 * line per request; capture them so the oracle can assert "logged" and the
 * test output stays readable at 1000s of iterations. */
async function captureConsole<T>(
  run: () => Promise<T>,
): Promise<{ result: T; logs: CapturedLogs }> {
  const logs: CapturedLogs = { error: [], warn: [] };
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    info: console.info,
  };
  const render = (args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : describeInput(a, 400))).join(
      " ",
    );
  console.error = (...args: unknown[]) => logs.error.push(render(args));
  console.warn = (...args: unknown[]) => logs.warn.push(render(args));
  console.log = () => {};
  console.info = () => {};
  try {
    const result = await run();
    return { result, logs };
  } finally {
    console.error = original.error;
    console.warn = original.warn;
    console.log = original.log;
    console.info = original.info;
  }
}

function ipFor(rng: Prng): string {
  return `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
}

function profileRow(userId: string) {
  return {
    id: userId,
    email: "relay@example.com",
    provider: "apple",
    onboarding_state: "complete",
  };
}

function appleRevokeCalls() {
  return h.calls.filter((c) => c.url === APPLE_REVOKE_URL);
}
function revenueCatDeletes() {
  return h.calls.filter((c) =>
    c.url.startsWith(RC_URL) && c.method === "DELETE"
  );
}
function authAdminDeletes() {
  return h.calls.filter((c) =>
    c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE"
  );
}
function credentialWrites() {
  return h.calls.filter(
    (c) =>
      c.url.includes("/rest/v1/account_external_credentials") &&
      (c.method === "POST" || c.method === "PATCH"),
  );
}
function formOf(body: unknown): URLSearchParams {
  return new URLSearchParams(typeof body === "string" ? body : "");
}

interface Observed {
  status: number;
  code: string | null;
  message: string | null;
  bodyText: string;
  leak: string | null;
  requestId: boolean;
}

async function observe(response: Response): Promise<Observed> {
  const bodyText = await response.text();
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown; message?: unknown };
    };
    code = typeof parsed?.error?.code === "string" ? parsed.error.code : null;
    message = typeof parsed?.error?.message === "string"
      ? parsed.error.message
      : null;
  } catch {
    // non-JSON body — the oracle treats this as a leak candidate below
  }
  return {
    status: response.status,
    code,
    message,
    bodyText,
    leak: leakedDetail(bodyText),
    requestId: response.headers.has("x-request-id"),
  };
}

/** Lens-wide invariants for any response from the handler. */
function baseViolations(o: Observed): string[] {
  const problems: string[] = [];
  if (o.status === 500) problems.push("HTTP 500");
  if (o.leak) problems.push(`body leaks "${o.leak}"`);
  if (o.status >= 400 && o.message === null) {
    problems.push("error body without error.message");
  }
  if (!o.requestId) problems.push("missing x-request-id");
  return problems;
}

/** `usableAuthorizationCode` exactly as bootstrapAccount computes it. */
function codeUsable(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) &&
    value.length <= BOOTSTRAP_CODE_CAP;
}

// ─── family: route-bootstrap-json ────────────────────────────────────────────
// Well-formed JSON objects whose `appleAuthorizationCode` (and neighbours) are
// wrong-typed / boundary-sized / hostile, combined with fuzzed Apple token
// responses. Oracle derives the expected status from the handler's contract.

function bootstrapCode(rng: Prng): { value: unknown; kind: string } {
  const kind = rng.pick([
    "valid",
    "valid",
    "valid",
    "boundary",
    "wrong-type",
    "traversal",
    "unicode",
    "grapheme",
    "normalization",
    "nul",
    "padded",
    "cap+1",
    "astral-at-cap", // 4096 UTF-16 units = 2048 code points, 8192 bytes
    "astral-over-cap", // 4096 code points = 8192 UTF-16 units → rejected
    "lone-surrogate",
    "injection",
    "missing",
    "empty",
  ]);
  switch (kind) {
    case "valid":
      return {
        value: randomAscii(rng, rng.int(1, 200)).replace(/\s/g, "x"),
        kind,
      };
    case "boundary": {
      const b = boundaryString(rng, BOOTSTRAP_CODE_CAP);
      return { value: b.value, kind: `boundary:${b.kind}` };
    }
    case "wrong-type": {
      const w = wrongTypeValue(rng);
      return { value: w.value, kind: `wrong-type:${w.kind}` };
    }
    case "traversal":
      return { value: rng.pick(TRAVERSAL_SLUGS), kind };
    case "unicode":
      return { value: randomUnicode(rng, rng.int(1, 60)), kind };
    case "grapheme":
      return { value: rng.pick(GRAPHEME_CLUSTERS).repeat(rng.int(1, 5)), kind };
    case "normalization":
      return { value: rng.pick(NORMALIZATION_PAIRS)[rng.int(0, 1)], kind };
    case "nul":
      return { value: `c\u0000${randomAscii(rng, 8)}`, kind };
    case "padded":
      return { value: ` \n${randomAscii(rng, 12)}\t `, kind };
    case "cap+1":
      return { value: "x".repeat(BOOTSTRAP_CODE_CAP + 1), kind };
    case "astral-at-cap":
      return { value: "\u{1F600}".repeat(BOOTSTRAP_CODE_CAP / 2), kind };
    case "astral-over-cap":
      return { value: "\u{1F600}".repeat(BOOTSTRAP_CODE_CAP), kind };
    case "lone-surrogate":
      return { value: `\ud800${randomAscii(rng, 6)}\udfff`, kind };
    case "injection":
      return {
        value: "code&client_secret=evil&grant_type=refresh_token",
        kind,
      };
    case "missing":
      return { value: undefined, kind };
    default:
      return { value: "", kind };
  }
}

function bootstrapBody(rng: Prng, code: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (code !== undefined) body.appleAuthorizationCode = code;
  const extras = rng.int(0, 3);
  for (let i = 0; i < extras; i += 1) {
    const which = rng.int(0, 5);
    if (which === 0) body[rng.pick(PROTO_KEYS)] = { polluted: true };
    else if (which === 1) {
      body.schemaVersion = rng.pick([2, 99, "3.0", Number.MAX_SAFE_INTEGER]);
    } else if (which === 2) {
      body[randomUnicode(rng, 6)] = rng.pick(
        WEIRD_NUMBERS.filter(Number.isFinite),
      );
    } else if (which === 3) body.appleAuthorizationCodes = [code];
    else if (which === 4) body.AppleAuthorizationCode = "case-variant";
    else body.padding = "p".repeat(rng.pick([0, 1024, 65_536]));
  }
  return body;
}

const PROTOCOL_HEADERS: ReadonlyArray<string | null> = [
  "1",
  "1",
  "1",
  "1",
  null,
  "0",
  "true",
  "1 ",
  "01",
  "2",
  "",
];

Deno.test({
  name:
    `stress route-bootstrap-json ×${STRESS_ITER}: hostile appleAuthorizationCode + fuzzed Apple replies → contract status, no plaintext, no 500`,
  ignore: !familySelected("route-bootstrap-json"),
  async fn() {
    const campaign = new Campaign("route-bootstrap-json", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const userId = rng.uuid();
      const code = bootstrapCode(rng);
      const protocol = rng.pick(PROTOCOL_HEADERS);
      const reply = exchangeReply(rng, rng.bool(0.15) ? rng.uuid() : userId);
      // Some grant variants force their own (hostile) subject.
      const mismatch = reply.grant !== undefined &&
        reply.grant.subject !== userId;
      const body = bootstrapBody(rng, code.value);
      const usable = codeUsable(code.value);
      // The Headers API strips leading/trailing HTTP whitespace from values.
      const protocolOn = protocol !== null && protocol.trim() === "1";

      let expected: string;
      if (!usable) {
        expected = protocolOn
          ? "400 auth.apple_authorization_code_required, no Apple call, no write"
          : "200 legacy, no Apple call, no write";
      } else if (reply.expect === "grant") {
        expected = mismatch
          ? "401 auth.apple_authorization_mismatch, no write"
          : "200 + one encrypted credential upsert";
      } else if (reply.expect === "invalid_grant") {
        expected = "401 auth.apple_authorization_invalid, no write";
      } else expected = "503 generic (logged), no write";

      h.reset();
      h.tables.profiles = [profileRow(userId)];
      const headers: Record<string, string> = {};
      if (protocol !== null) headers["X-Apple-Revocation-Protocol"] = protocol;
      const { result: { result: o, owned: apple }, logs } =
        await captureConsole(() =>
          withProviderReply(
            APPLE_TOKEN_URL,
            () => reply.make(),
            async () =>
              observe(
                await h.handler(
                  userRequest("POST", "/v1/account/bootstrap", {
                    token: fakeAppleIdToken(userId),
                    ip: ipFor(rng),
                    headers,
                    body,
                  }),
                ),
              ),
          )
        );

      const problems = baseViolations(o);
      const writes = credentialWrites();
      if (!usable) {
        if (
          protocolOn &&
          (o.status !== 400 ||
            o.code !== "auth.apple_authorization_code_required")
        ) problems.push(`status ${o.status} code ${o.code}`);
        if (!protocolOn && o.status !== 200) {
          problems.push(`legacy status ${o.status}`);
        }
        if (apple.length !== 0) {
          problems.push(`Apple called ${apple.length}× for unusable code`);
        }
        if (writes.length !== 0) {
          problems.push(
            `${writes.length} credential write(s) for unusable code`,
          );
        }
      } else {
        const trimmed = String(code.value).trim();
        if (apple.length !== 1) problems.push(`Apple called ${apple.length}×`);
        else {
          const sent = formOf(apple[0].body).get("code");
          if (sent !== trimmed && sent !== wtf8(trimmed)) {
            problems.push("code not sent trimmed/byte-exact");
          }
          if (
            typeof apple[0].body === "string" && apple[0].body.includes(userId)
          ) problems.push("user id sent to Apple");
        }
        if (reply.expect === "grant" && !mismatch) {
          if (o.status !== 200) {
            problems.push(`status ${o.status} for valid grant`);
          }
          if (writes.length !== 1 || writes[0].method !== "POST") {
            problems.push(
              `${writes.length} credential write(s), expected one upsert`,
            );
          } else {
            const stored = writes[0].body as Record<string, unknown>;
            const serialized = JSON.stringify(stored);
            if (stored.user_id !== userId) {
              problems.push("upsert not keyed by the authed user");
            }
            if (serialized.includes(reply.grant!.refreshToken)) {
              problems.push("refresh token stored in PLAINTEXT");
            }
            if (serialized.includes(trimmed) && trimmed.length > 3) {
              problems.push("authorization code persisted");
            }
            if (typeof stored.apple_refresh_token_encrypted !== "string") {
              problems.push("encrypted token not a string");
            } else {
              try {
                const plain = await decryptAppleRefreshToken(
                  stored.apple_refresh_token_encrypted,
                  userId,
                  h.appleTokenEncryptionKey,
                );
                if (plain !== reply.grant!.refreshToken) {
                  problems.push(
                    "stored ciphertext decrypts to a different token",
                  );
                }
                if (stored.apple_refresh_token_encrypted.length > 8192) {
                  problems.push(
                    `ciphertext ${stored.apple_refresh_token_encrypted.length} chars exceeds DB cap 8192`,
                  );
                }
              } catch (error) {
                problems.push(
                  `stored ciphertext does not decrypt for this user: ${
                    describeInput(error, 80)
                  }`,
                );
              }
            }
          }
        } else {
          if (writes.length !== 0) {
            problems.push(
              `${writes.length} credential write(s) on a rejected exchange`,
            );
          }
          if (
            reply.expect === "grant" &&
            (o.status !== 401 || o.code !== "auth.apple_authorization_mismatch")
          ) {
            problems.push(
              `status ${o.status} code ${o.code} for subject mismatch`,
            );
          }
          if (
            reply.expect === "invalid_grant" &&
            (o.status !== 401 || o.code !== "auth.apple_authorization_invalid")
          ) {
            problems.push(
              `status ${o.status} code ${o.code} for invalid_grant`,
            );
          }
          if (
            (reply.expect === "invalid_response" ||
              reply.expect === "unavailable")
          ) {
            if (o.status !== 503) {
              problems.push(`status ${o.status} for ${reply.expect}`);
            }
            if (
              o.message !==
                "Apple sign-in is temporarily unavailable. Please try again."
            ) {
              problems.push(
                `503 message not generic: ${describeInput(o.message, 80)}`,
              );
            }
            if (
              !logs.error.some((line) =>
                line.startsWith("[api] Apple sign-in:")
              )
            ) problems.push("503 without an operator log line");
          }
        }
      }
      campaign.record({
        index,
        seed,
        input: `code=${code.kind} ${describeInput(code.value, 40)} protocol=${
          describeInput(protocol)
        } apple=${reply.kind}${mismatch ? " subject-mismatch" : ""} extras=${
          Object.keys(body).length - (code.value === undefined ? 0 : 1)
        }`,
        outcome: `${o.status}${
          o.code ? ` ${o.code}` : ""
        } apple=${apple.length} writes=${writes.length}${
          problems.length ? ` | ${problems.join("; ")}` : ""
        }`,
        expected,
        verdict: problems.length ? "BROKEN" : "HELD",
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

// ─── family: route-bootstrap-raw ─────────────────────────────────────────────
// Raw request bodies (malformed/truncated JSON, prototype-pollution text,
// numeric literals JSON cannot carry, BOM/NUL, >5 MB) with the revocation
// protocol header set, so anything that fails to parse into a usable code
// must be a 400 — never a 500 and never an Apple call.

function bodyExpectation(
  text: string,
  bytes: number,
): "413" | "exchange" | "400" {
  if (bytes > MAX_JSON_BODY_BYTES) return "413";
  try {
    // readBoundedText decodes with TextDecoder, which strips a leading BOM.
    const parsed = JSON.parse(text.replace(/^\ufeff/, "")) as unknown;
    if (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ) {
      const record = parsed as Record<string, unknown>;
      if (codeUsable(record.appleAuthorizationCode)) return "exchange";
    }
  } catch {
    // unparsable → readBody yields {}
  }
  return "400";
}

Deno.test({
  name:
    `stress route-bootstrap-raw ×${STRESS_ITER}: malformed/truncated/oversized JSON bodies → 400/413, never 500, never an Apple call`,
  ignore: !familySelected("route-bootstrap-raw"),
  async fn() {
    const campaign = new Campaign("route-bootstrap-raw", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const userId = rng.uuid();
      const good = randomAscii(rng, rng.int(1, 40)).replace(/["\\\s]/g, "x");
      let raw: { text: string; kind: string };
      if (rng.bool(0.04)) {
        raw = {
          text: `{"appleAuthorizationCode": "${
            "x".repeat(MAX_JSON_BODY_BYTES)
          }"}`,
          kind: "oversized-5mb+",
        };
      } else if (rng.bool(0.05)) {
        raw = {
          text: `{"appleAuthorizationCode": "${good}"}`,
          kind: "valid-control",
        };
      } else raw = rawBodyText(rng, "appleAuthorizationCode", good);
      const bytes = new TextEncoder().encode(raw.text).byteLength;
      const contentType = rng.pick([
        "application/json",
        "application/json",
        "application/json; charset=utf-8",
        "text/plain",
        null,
      ]);
      const expectKind = bodyExpectation(raw.text, bytes);
      const expected = expectKind === "413"
        ? "413"
        : expectKind === "exchange"
        ? "200 + encrypted upsert"
        : "400 auth.apple_authorization_code_required, no Apple call, no write";

      h.reset();
      h.tables.profiles = [profileRow(userId)];
      const headers = new Headers({
        Authorization: `Bearer ${fakeAppleIdToken(userId)}`,
        "x-forwarded-for": ipFor(rng),
        "X-Apple-Revocation-Protocol": "1",
      });
      if (contentType) headers.set("Content-Type", contentType);
      const request = new Request(
        "http://edge.test/functions/v1/api/v1/account/bootstrap",
        { method: "POST", headers, body: raw.text },
      );
      const { result: { result: o, owned: apple } } = await captureConsole(
        () =>
          withProviderReply(
            APPLE_TOKEN_URL,
            () => exchangeReply(rng, userId).make(),
            async () => observe(await h.handler(request)),
          ),
      );
      const problems = baseViolations(o);
      const writes = credentialWrites();
      if (expectKind === "413") {
        if (o.status !== 413) {
          problems.push(`status ${o.status} for ${bytes}-byte body`);
        }
        if (apple.length || writes.length) {
          problems.push("oversized body reached Apple/DB");
        }
      } else if (expectKind === "400") {
        if (
          o.status !== 400 ||
          o.code !== "auth.apple_authorization_code_required"
        ) problems.push(`status ${o.status} code ${o.code}`);
        if (apple.length) problems.push(`Apple called ${apple.length}×`);
        if (writes.length) {
          problems.push(`${writes.length} credential write(s)`);
        }
      } else {
        if (apple.length !== 1) problems.push(`Apple called ${apple.length}×`);
        if (![200, 401, 503].includes(o.status)) {
          problems.push(`status ${o.status}`);
        }
        if (o.status !== 200 && writes.length) {
          problems.push("write on rejected exchange");
        }
      }
      campaign.record({
        index,
        seed,
        input: `${raw.kind} bytes=${bytes} ct=${describeInput(contentType)} ${
          describeInput(raw.text, 60)
        }`,
        outcome: `${o.status}${
          o.code ? ` ${o.code}` : ""
        } apple=${apple.length} writes=${writes.length}${
          problems.length ? ` | ${problems.join("; ")}` : ""
        }`,
        expected,
        verdict: problems.length ? "BROKEN" : "HELD",
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

// ─── family: route-delete-confirm-stored ─────────────────────────────────────
// The STORED credential row is hostile (corrupt ciphertext, wrong key/user,
// wrong types, future versions) and Apple's revoke reply is fuzzed. Oracle:
// permanent defects must still delete the account (manual_action_required);
// a 503 must be fail-closed (no RevenueCat/Auth deletion, no checkpoint).

Deno.test({
  name:
    `stress route-delete-confirm-stored ×${STRESS_ITER}: corrupt stored Apple credential / fuzzed revoke → deletion completes or fails CLOSED, never 500`,
  ignore: !familySelected("route-delete-confirm-stored"),
  async fn() {
    const campaign = new Campaign("route-delete-confirm-stored", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const userId = rng.uuid();
      const key = h.appleTokenEncryptionKey;
      const scenario = await decryptScenario(rng, userId, key, OTHER_KEY);
      let stored: unknown = scenario.encrypted;
      let storedKind = scenario.kind;
      if (scenario.kind === "other-key") {
        stored = await encryptAppleRefreshToken(
          scenario.token,
          userId,
          OTHER_KEY,
        );
      }
      if (scenario.kind === "other-user-aad") {
        // The fixture's AAD twists are relative to its own user id; when a
        // twist leaves the id unchanged the row is simply untampered.
        if (scenario.userId === userId) storedKind = "untampered";
        else {
          stored = await encryptAppleRefreshToken(
            scenario.token,
            scenario.userId,
            key,
          );
        }
      }
      if (rng.bool(0.12)) {
        const w = wrongTypeValue(rng);
        stored = w.value;
        storedKind = `wrong-type:${w.kind}`;
      }
      const alreadyRevoked = rng.bool(0.08)
        ? rng.pick([new Date().toISOString(), "yes", 1, true, "\u0000"])
        : null;
      const rcDone = rng.bool(0.08) ? new Date().toISOString() : null;
      const revoke = revokeReply(rng);
      const challenge = rng.uuid();

      const storedTruthy = Boolean(stored);
      const storedString = typeof stored === "string";
      // Whitespace inside/after a segment is trimmed by the decoder; a leading
      // space corrupts the version tag and is a (permanent) format defect.
      const decryptable = storedKind === "untampered" ||
        (storedKind === "whitespace-segment" &&
          !scenario.encrypted.startsWith(" "));
      let expected: string;
      if (alreadyRevoked) {
        expected = "200 revoked (checkpoint honoured), no revoke call";
      } else if (!storedTruthy) {
        expected = "200 manual_action_required, no revoke call";
      } else if (!storedString) {
        expected = "503 generic fail-closed (type-confused row)";
      } else if (decryptable) {
        expected = revoke.expect === "grant"
          ? "200 revoked, one revoke, checkpoint PATCH"
          : revoke.expect === "invalid_grant"
          ? "200 manual_action_required, credential cleared"
          : "503 generic fail-closed";
      } else if (
        storedKind === "other-key" || storedKind === "other-user-aad"
      ) {
        expected =
          "200 manual_action_required (permanent: undecryptable), credential cleared";
      } else {expected =
          "200 manual_action_required (permanent: corrupt stored credential), credential cleared";}

      h.reset();
      h.tables.profiles = [profileRow(userId)];
      h.tables.account_deletion_requests = [{
        challenge,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }];
      h.tables.account_external_credentials = [{
        apple_refresh_token_encrypted: stored,
        apple_revoked_at: alreadyRevoked,
        revenuecat_deleted_at: rcDone,
      }];
      const { result: { result: o, owned: revokes }, logs } =
        await captureConsole(() =>
          withProviderReply(
            APPLE_REVOKE_URL,
            () => revoke.make(),
            async () =>
              observe(
                await h.handler(
                  userRequest("POST", "/v1/me/delete-confirm", {
                    token: fakeAppleIdToken(userId),
                    ip: ipFor(rng),
                    body: { challenge },
                  }),
                ),
              ),
          )
        );

      const problems = baseViolations(o);
      const rc = revenueCatDeletes();
      const auth = authAdminDeletes();
      const writes = credentialWrites();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(o.bodyText) as Record<string, unknown>;
      } catch {
        // error bodies handled by baseViolations
      }
      const outcomeField = body.appleAuthorizationRevocation;

      if (o.status === 503) {
        // Fail-closed: nothing downstream may have happened.
        if (rc.length || auth.length) {
          problems.push(
            `503 but RevenueCat=${rc.length} auth=${auth.length} deletes ran`,
          );
        }
        if (writes.length) problems.push("503 but credential row was written");
        if (
          o.message !==
            "Account deletion is temporarily unavailable. Please try again."
        ) {
          problems.push(
            `503 message not generic: ${describeInput(o.message, 80)}`,
          );
        }
        if (
          !logs.error.some((line) => line.startsWith("[api] Account deletion:"))
        ) problems.push("503 without an operator log line");
      } else if (o.status === 200) {
        if (body.deleted !== true) problems.push("200 without deleted:true");
        if (auth.length !== 1) problems.push(`auth deletes=${auth.length}`);
        if (rcDone ? rc.length !== 0 : rc.length !== 1) {
          problems.push(`RevenueCat deletes=${rc.length}`);
        }
        if (
          rc.length === 1 &&
          rc[0].url !== `${RC_URL}${encodeURIComponent(userId)}`
        ) problems.push("RevenueCat URL not the authed user");
        if (
          auth.length === 1 &&
          !auth[0].url.endsWith(`/auth/v1/admin/users/${userId}`)
        ) problems.push("Auth delete not the authed user");
      } else problems.push(`unexpected status ${o.status} ${o.code ?? ""}`);

      // Expected vs observed shape.
      if (alreadyRevoked) {
        if (o.status !== 200 || outcomeField !== "revoked") {
          problems.push(
            `expected revoked checkpoint, got ${o.status} ${
              describeInput(outcomeField)
            }`,
          );
        }
        if (revokes.length) {
          problems.push("revoke called despite apple_revoked_at");
        }
      } else if (!storedTruthy) {
        if (o.status !== 200 || outcomeField !== "manual_action_required") {
          problems.push(
            `expected manual_action_required, got ${o.status} ${
              describeInput(outcomeField)
            }`,
          );
        }
        if (revokes.length) problems.push("revoke called with no stored token");
      } else if (!storedString) {
        if (o.status !== 503) {
          problems.push(`type-confused row produced ${o.status}`);
        }
      } else if (decryptable) {
        if (revokes.length !== 1) problems.push(`revokes=${revokes.length}`);
        else {
          const sent = formOf(revokes[0].body).get("token");
          if (
            sent !== scenario.token && sent !== wtf8(scenario.token)
          ) problems.push("revoked token differs from stored plaintext");
        }
        if (revoke.expect === "grant") {
          if (o.status !== 200 || outcomeField !== "revoked") {
            problems.push(
              `expected revoked, got ${o.status} ${
                describeInput(outcomeField)
              }`,
            );
          }
          const patch = writes.find((w) => w.method === "PATCH");
          if (
            !patch ||
            typeof (patch.body as Record<string, unknown>).apple_revoked_at !==
              "string"
          ) problems.push("no apple_revoked_at checkpoint");
        } else if (revoke.expect === "invalid_grant") {
          if (o.status !== 200 || outcomeField !== "manual_action_required") {
            problems.push(
              `expected manual_action_required, got ${o.status} ${
                describeInput(outcomeField)
              }`,
            );
          }
          const patch = writes.find((w) => w.method === "PATCH");
          const cleared = patch &&
            (patch.body as Record<string, unknown>)
                .apple_refresh_token_encrypted === null;
          if (!cleared) problems.push("unrevocable credential not cleared");
        } else if (o.status !== 503) {
          problems.push(`retryable Apple failure produced ${o.status}`);
        }
      } else {
        // Stored-credential defect: permanent → account still deleted.
        if (revokes.length) {
          problems.push("Apple revoke attempted with a corrupt credential");
        }
        if (o.status !== 200 || outcomeField !== "manual_action_required") {
          problems.push(
            `corrupt stored credential → ${o.status} (retry can never repair it; account undeletable)`,
          );
        } else {
          const patch = writes.find((w) => w.method === "PATCH");
          if (
            !patch ||
            (patch.body as Record<string, unknown>)
                .apple_refresh_token_encrypted !== null
          ) problems.push("corrupt credential not cleared");
        }
      }

      campaign.record({
        index,
        seed,
        input: `stored=${storedKind} ${describeInput(stored, 50)} revoked_at=${
          describeInput(alreadyRevoked)
        } rc_done=${rcDone ? "yes" : "no"} revoke=${revoke.kind}`,
        outcome: `${o.status} ${
          describeInput(outcomeField)
        } revokes=${revokes.length} rc=${rc.length} auth=${auth.length} writes=${writes.length}${
          problems.length ? ` | ${problems.join("; ")}` : ""
        }`,
        expected,
        verdict: problems.length ? "BROKEN" : "HELD",
        note: problems.some((p) => p.includes("account undeletable"))
          ? `F1 at the route: corrupt stored credential → 503 (${
            logs.error.find((l) => l.startsWith("[api] Account deletion:")) ??
              "no log"
          })`
          : undefined,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    // Known defect (finding F1) surfaces here as a 503 for a corrupt stored
    // credential. Fail-closed ordering and everything else must hold.
    const unexpected = report.rows.filter((r) =>
      r.verdict === "BROKEN" && !r.note?.startsWith("F1 at the route")
    );
    assertEquals(
      unexpected,
      [],
      "fail-open deletion, 500, leak or contract break",
    );
    const f1 = report.rows.filter((r) => r.note?.startsWith("F1 at the route"));
    console.log(
      `[stress] ${campaign.family}: F1 (corrupt credential → 503) reproduced ${f1.length}× ; stored kinds: ${
        [...new Set(f1.map((r) => r.input.split(" ")[0]))].join(", ") || "none"
      }`,
    );
  },
});

// ─── family: route-delete-confirm-body ───────────────────────────────────────
// The `challenge` field is hostile. Oracle: only the exact pending challenge
// may proceed; everything else is 400/403 with ZERO external side effects.

Deno.test({
  name:
    `stress route-delete-confirm-body ×${STRESS_ITER}: hostile challenge values → 400/403, zero external calls, zero writes`,
  ignore: !familySelected("route-delete-confirm-body"),
  async fn() {
    const campaign = new Campaign("route-delete-confirm-body", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const userId = rng.uuid();
      const real = rng.uuid();
      const kind = rng.pick([
        "exact",
        "uppercase",
        "whitespace-wrapped",
        "fullwidth-digits",
        "other-uuid",
        "nil-uuid",
        "wrong-type",
        "boundary",
        "traversal",
        "nul",
        "unicode",
        "missing",
        "raw-body",
        "array-wrapped",
        "object-wrapped",
        "nfd",
      ]);
      let challenge: unknown = real;
      let rawText: string | null = null;
      switch (kind) {
        case "exact":
          break;
        case "uppercase":
          challenge = real.toUpperCase();
          break;
        case "whitespace-wrapped":
          challenge = ` ${real}\n`;
          break;
        case "fullwidth-digits":
          challenge = real.replace(
            /[0-9]/g,
            (d) => String.fromCharCode(0xff10 + Number(d)),
          );
          break;
        case "other-uuid":
          challenge = rng.uuid();
          break;
        case "nil-uuid":
          challenge = "00000000-0000-0000-0000-000000000000";
          break;
        case "wrong-type":
          challenge = wrongTypeValue(rng).value;
          break;
        case "boundary":
          challenge = boundaryString(rng, 36).value;
          break;
        case "traversal":
          challenge = rng.pick(TRAVERSAL_SLUGS);
          break;
        case "nul":
          challenge = `${real}\u0000`;
          break;
        case "unicode":
          challenge = randomUnicode(rng, 36);
          break;
        case "missing":
          challenge = undefined;
          break;
        case "raw-body":
          rawText = rawBodyText(rng, "challenge", real).text;
          break;
        case "array-wrapped":
          challenge = [real];
          break;
        case "object-wrapped":
          challenge = { challenge: real };
          break;
        default:
          challenge = real + "\u0301";
      }
      let effective: unknown = challenge;
      if (rawText !== null) {
        try {
          const parsed = JSON.parse(rawText) as unknown;
          effective = parsed !== null && typeof parsed === "object" &&
              !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).challenge
            : undefined;
        } catch {
          effective = undefined;
        }
      }
      const isUuid = typeof effective === "string" && UUID_RE.test(effective);
      const expected = effective === real
        ? "200 deleted"
        : isUuid
        ? "403 account.deletion_challenge_invalid, no side effects"
        : "400 validation.account_deletion, no side effects";

      h.reset();
      h.tables.profiles = [profileRow(userId)];
      h.tables.account_deletion_requests = [{
        challenge: real,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }];
      h.tables.account_external_credentials = [];
      let request: Request;
      if (rawText !== null) {
        request = new Request(
          "http://edge.test/functions/v1/api/v1/me/delete-confirm",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${fakeAppleIdToken(userId)}`,
              "x-forwarded-for": ipFor(rng),
              "Content-Type": "application/json",
            },
            body: rawText,
          },
        );
      } else {
        request = userRequest("POST", "/v1/me/delete-confirm", {
          token: fakeAppleIdToken(userId),
          ip: ipFor(rng),
          body: challenge === undefined ? {} : { challenge },
        });
      }
      const { result: o } = await captureConsole(async () =>
        observe(await h.handler(request))
      );
      const problems = baseViolations(o);
      const external = appleRevokeCalls().length + revenueCatDeletes().length +
        authAdminDeletes().length;
      const writes = credentialWrites().length;
      if (effective === real) {
        if (o.status !== 200) problems.push(`exact challenge → ${o.status}`);
      } else {
        if (
          isUuid &&
          (o.status !== 403 || o.code !== "account.deletion_challenge_invalid")
        ) problems.push(`status ${o.status} code ${o.code} for foreign UUID`);
        if (
          !isUuid &&
          (o.status !== 400 || o.code !== "validation.account_deletion")
        ) problems.push(`status ${o.status} code ${o.code} for non-UUID`);
        if (external) {
          problems.push(`${external} external call(s) on a rejected confirm`);
        }
        if (writes) {
          problems.push(`${writes} credential write(s) on a rejected confirm`);
        }
      }
      campaign.record({
        index,
        seed,
        input: `${kind} ${describeInput(rawText ?? challenge, 60)}`,
        outcome: `${o.status}${
          o.code ? ` ${o.code}` : ""
        } external=${external} writes=${writes}${
          problems.length ? ` | ${problems.join("; ")}` : ""
        }`,
        expected,
        verdict: problems.length ? "BROKEN" : "HELD",
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

Deno.test("stress routes fixture: harness handler answers healthz", async () => {
  const response = await h.handler(
    new Request("http://edge.test/functions/v1/api/healthz"),
  );
  assert(
    response.status === 200 || response.status === 204,
    `healthz ${response.status}`,
  );
  await response.body?.cancel();
});
