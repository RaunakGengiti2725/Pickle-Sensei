/**
 * STRESS (lens: boundary-malformed) — externalAccounts.ts, module plane.
 *
 * Drives the exported functions directly with seeded malformed/boundary
 * inputs: stored-credential ciphertext variants, encryption-key variants,
 * refresh-token round trips (byte/codepoint/grapheme caps, NUL, lone
 * surrogates, 64KB+, normalization pairs), malformed Apple token/revoke
 * responses (wrong types, prototype keys, non-JSON, weird statuses, thrown
 * fetch), RevenueCat ids with traversal/unicode/empty, secrets with CRLF,
 * malformed private keys.
 *
 * Invariant under test (per scenario, see the oracle in each family):
 *   - the ONLY thing that ever leaves a function is a typed
 *     ExternalAccountError (or the documented success value) — never a bare
 *     TypeError/DOMException/RangeError, never a forged plaintext;
 *   - `kind` must be truthful about retryability: a defect in the STORED
 *     credential (valid key, valid user) can never be fixed by a retry, so it
 *     must be permanent (invalid_response / invalid_grant); a defect in the
 *     operator secret must be `configuration`;
 *   - a configuration failure is detected BEFORE any provider request leaves;
 *   - provider request bodies carry the caller's code/token byte-for-byte.
 *
 * Results: <STRESS_OUT_DIR>/<family>.json (seed → outcome → verdict).
 * Replay one seed: see `replay` in the JSON (STRESS_REPLAY_SEED=<seed>).
 */
import { assert, assertEquals } from "@std/assert";
import {
  AppleServerConfiguration,
  decryptAppleRefreshToken,
  deleteRevenueCatCustomer,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  ExternalAccountError,
  isPermanentExternalAccountError,
  revokeAppleRefreshToken,
} from "../externalAccounts.ts";
import {
  b64std,
  b64url,
  boundaryString,
  Campaign,
  describeInput,
  errorSummary,
  familySelected,
  GRAPHEME_CLUSTERS,
  NORMALIZATION_PAIRS,
  Prng,
  randomAscii,
  randomUnicode,
  seedsFor,
  STRESS_ITER,
  TRAVERSAL_SLUGS,
  WEIRD_NUMBERS,
  wrongTypeValue,
} from "./stress_external_accounts_gen.ts";
import {
  AUTH_CODE_POOL,
  decodeUrl,
  decryptScenario,
  exchangeReply,
  fakeJwt,
  jsonResponse,
  LONE_SURROGATE,
  revokeReply,
  wtf8,
} from "./stress_external_accounts_fixtures.ts";

const FILE = "stress_external_accounts_module.test.ts";
const DB_CIPHERTEXT_CAP = 8192; // account_external_credentials CHECK (20260902140000)

// ─── fixtures ────────────────────────────────────────────────────────────────

function pem(label: string, der: ArrayBuffer): string {
  const lines = b64std(new Uint8Array(der)).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${
    lines.join("\n")
  }\n-----END ${label}-----`;
}

const p256 = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  [
    "sign",
    "verify",
  ],
);
const P256_PEM = pem(
  "PRIVATE KEY",
  await crypto.subtle.exportKey("pkcs8", p256.privateKey),
);
const p384 = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-384" },
  true,
  [
    "sign",
    "verify",
  ],
);
const P384_PEM = pem(
  "PRIVATE KEY",
  await crypto.subtle.exportKey("pkcs8", p384.privateKey),
);
const rsa = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const RSA_PEM = pem(
  "PRIVATE KEY",
  await crypto.subtle.exportKey("pkcs8", rsa.privateKey),
);

const VALID_KEY = b64std(crypto.getRandomValues(new Uint8Array(32)));
const OTHER_KEY = b64std(crypto.getRandomValues(new Uint8Array(32)));
const USER_ID = "11111111-1111-4111-8111-111111111111";

const CONFIG: AppleServerConfiguration = {
  clientId: "com.picklesensei",
  teamId: "TEAMID1234",
  keyId: "KEYID12345",
  privateKeyPem: P256_PEM,
  tokenEncryptionKey: VALID_KEY,
};

type Recorded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: URLSearchParams | null;
};

/** fetch stub that records the request and replies with `reply` (or throws). */
function stubFetch(
  reply: () => Response | Promise<Response>,
  calls: Recorded[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    const text = await request.text();
    calls.push({
      url: request.url,
      method: request.method,
      headers,
      form: text ? new URLSearchParams(text) : null,
    });
    return await reply();
  }) as typeof fetch;
}

function classifyError(
  error: unknown,
): { typed: boolean; kind: string; message: string } {
  if (error instanceof ExternalAccountError) {
    return { typed: true, kind: error.kind, message: error.message };
  }
  return { typed: false, kind: "untyped", message: errorSummary(error) };
}

Deno.test({
  name:
    `stress decrypt-stored-credential ×${STRESS_ITER}: corrupt stored ciphertext → typed PERMANENT error, never plaintext`,
  ignore: !familySelected("decrypt-stored-credential"),
  async fn() {
    const campaign = new Campaign("decrypt-stored-credential", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const s = await decryptScenario(rng, USER_ID, VALID_KEY, OTHER_KEY);
      const storedDefect = s.kind !== "untampered" && s.kind !== "other-key" &&
        s.kind !== "other-user-aad";
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      let note: string | undefined;
      const expected = s.expectPlaintext !== null
        ? "returns plaintext"
        : storedDefect
        ? "ExternalAccountError kind∈{invalid_response,invalid_grant} (permanent)"
        : "ExternalAccountError invalid_response";
      try {
        const plaintext = await decryptAppleRefreshToken(
          s.encrypted,
          s.userId,
          s.key,
        );
        if (s.expectPlaintext !== null && plaintext === s.expectPlaintext) {
          outcome = "returns plaintext";
        } else if (
          plaintext === s.token && s.userId === USER_ID && s.key === VALID_KEY
        ) {
          // The GCM tag verified and the GENUINE token came back, so the decoded
          // bytes equal the genuine ciphertext: the extra characters were an
          // EQUIVALENT encoding (String.prototype.trim strips ASCII whitespace,
          // NBSP, U+2000-U+200A, U+FEFF …; atob ignores ASCII whitespace).
          const extra = [...s.encrypted].filter((ch) =>
            !/[A-Za-z0-9._-]/.test(ch)
          )
            .map((ch) =>
              `U+${
                ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
              }`
            );
          outcome =
            `returns plaintext (tolerant decode of the genuine ciphertext; extra chars ${
              [...new Set(extra)].join(",") || "none"
            })`;
        } else {
          outcome = `returns plaintext for TAMPERED input: ${
            describeInput(plaintext, 60)
          }`;
          verdict = "BROKEN";
        }
      } catch (error) {
        const c = classifyError(error);
        outcome = c.typed
          ? `ExternalAccountError ${c.kind}`
          : `UNTYPED ${c.message}`;
        if (!c.typed || s.expectPlaintext !== null) verdict = "BROKEN";
        else if (!isPermanentExternalAccountError(error)) {
          verdict = "BROKEN";
          note =
            `retryable kind for a stored-credential defect → delete-confirm 503 forever; message="${c.message}"`;
        }
      }
      campaign.record({
        index,
        seed,
        input: s.input,
        outcome,
        expected,
        verdict,
        note,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    const brokenKinds = new Set(
      report.rows.filter((r) => r.verdict === "BROKEN").map((r) =>
        r.input.split(" ")[0]
      ),
    );
    // Known defect (finding F1): non-base64 IV/ciphertext segments are
    // reported as `configuration` (retryable). Everything else must hold.
    const unexpected = report.rows.filter((r) =>
      r.verdict === "BROKEN" && !r.note?.includes("retryable kind")
    );
    assertEquals(unexpected, [], "untyped throw or forged plaintext");
    console.log(
      `[stress] BROKEN kinds (retryable misclassification): ${
        [...brokenKinds].join(", ") || "none"
      }`,
    );
  },
});

// ─── family: decrypt-key-boundary ────────────────────────────────────────────
// Valid stored ciphertext; the OPERATOR KEY is what varies. Oracle: equivalent
// encodings decrypt; malformed keys → `configuration`; a different valid key
// → `invalid_response`; never an untyped throw or forged plaintext.

Deno.test({
  name:
    `stress decrypt-key-boundary ×${STRESS_ITER}: malformed APPLE_TOKEN_ENCRYPTION_KEY → configuration, never untyped`,
  ignore: !familySelected("decrypt-key-boundary"),
  async fn() {
    const campaign = new Campaign("decrypt-key-boundary", FILE);
    const raw = Uint8Array.from(atob(VALID_KEY), (c) => c.charCodeAt(0));
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const token = randomAscii(rng, rng.int(1, 64));
      const good = await encryptAppleRefreshToken(token, USER_ID, VALID_KEY);
      const kind = rng.pick([
        "same",
        "urlsafe-nopad",
        "ws-wrapped",
        "inner-ws",
        "inner-newline-every-4",
        "31-bytes",
        "33-bytes",
        "0-bytes",
        "64-bytes",
        "hex-64",
        "nonbase64",
        "unicode",
        "huge",
        "nul",
        "other-valid",
        "len-mod4-1",
        "empty",
        "traversal",
      ]);
      let key: string;
      let expected: string;
      switch (kind) {
        case "same":
          key = VALID_KEY;
          expected = "plaintext";
          break;
        case "urlsafe-nopad":
          key = b64url(raw);
          expected = "plaintext";
          break;
        case "ws-wrapped":
          key = ` \n${VALID_KEY}\t\r\n`;
          expected = "plaintext";
          break;
        case "inner-ws":
          key = VALID_KEY.slice(0, 8) + rng.pick([" ", "\n", "\t"]) +
            VALID_KEY.slice(8);
          expected = "configuration|plaintext"; // forgiving base64 strips ASCII whitespace; padding math may reject
          break;
        case "inner-newline-every-4":
          key = VALID_KEY.match(/.{1,4}/g)!.join("\n");
          expected = "configuration|plaintext";
          break;
        case "31-bytes":
          key = b64std(rng.bytes(31));
          expected = "configuration";
          break;
        case "33-bytes":
          key = b64std(rng.bytes(33));
          expected = "configuration";
          break;
        case "0-bytes":
          key = "====";
          expected = "configuration";
          break;
        case "64-bytes":
          key = b64std(rng.bytes(64));
          expected = "configuration";
          break;
        case "hex-64":
          key = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join(
            "",
          );
          expected = "configuration";
          break;
        case "nonbase64":
          key = rng.pick([
            "!!!!!!!!",
            VALID_KEY.replace(/[A-Za-z]/, "*"),
            VALID_KEY + "!",
          ]);
          expected = "configuration";
          break;
        case "unicode":
          key = randomUnicode(rng, 44);
          expected = "configuration";
          break;
        case "huge":
          key = "A".repeat(65_536);
          expected = "configuration";
          break;
        case "nul":
          key = VALID_KEY + "\u0000";
          expected = "configuration";
          break;
        case "other-valid":
          key = OTHER_KEY;
          expected = "invalid_response";
          break;
        case "len-mod4-1":
          key = VALID_KEY.replace(/=+$/, "") + "A";
          expected = "configuration";
          break;
        case "empty":
          key = "";
          expected = "configuration";
          break;
        default:
          key = rng.pick(TRAVERSAL_SLUGS);
          expected = "configuration";
      }
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      try {
        const plaintext = await decryptAppleRefreshToken(good, USER_ID, key);
        outcome = plaintext === token
          ? "plaintext"
          : `FORGED plaintext ${describeInput(plaintext, 40)}`;
        if (plaintext !== token || !expected.includes("plaintext")) {
          verdict = "BROKEN";
        }
      } catch (error) {
        const c = classifyError(error);
        outcome = c.typed ? c.kind : `UNTYPED ${c.message}`;
        if (!c.typed || !expected.split("|").includes(c.kind)) {
          verdict = "BROKEN";
        }
      }
      campaign.record({
        index,
        seed,
        input: `${kind} ${describeInput(key, 60)}`,
        outcome,
        expected,
        verdict,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

// ─── family: encrypt-roundtrip ───────────────────────────────────────────────
// Refresh-token and user-id boundary values. Oracle: ciphertext has the
// documented shape; decrypt(same user, same key) === token for every
// well-formed UTF-16 token; a different user (normalization pair, case,
// whitespace, NUL suffix) never decrypts; ciphertext ≤ 8192 chars is
// recorded against the DB CHECK so the PG plane can be cross-checked.

Deno.test({
  name:
    `stress encrypt-roundtrip ×${STRESS_ITER}: token/user boundary values round-trip and stay user-bound`,
  ignore: !familySelected("encrypt-roundtrip"),
  async fn() {
    const campaign = new Campaign("encrypt-roundtrip", FILE);
    const shape = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const pickToken = rng.int(0, 5);
      let token: string;
      let tokenKind: string;
      if (pickToken === 0) {
        const b = boundaryString(rng, 4096);
        token = b.value;
        tokenKind = b.kind;
      } else if (pickToken === 1) {
        token = randomUnicode(rng, rng.int(1, 200));
        tokenKind = "unicode";
      } else if (pickToken === 2) {
        token = rng.pick(GRAPHEME_CLUSTERS);
        tokenKind = "grapheme";
      } else if (pickToken === 3) {
        token = rng.pick(NORMALIZATION_PAIRS)[rng.int(0, 1)];
        tokenKind = "normalization";
      } else if (pickToken === 4) {
        token = "x".repeat(rng.pick([6112, 6113, 6114, 6115, 8192, 10_000]));
        tokenKind = "db-cap-edge";
      } else {
        token = randomAscii(rng, rng.int(1, 300));
        tokenKind = "ascii";
      }
      const userId = rng.pick([
        USER_ID,
        rng.uuid(),
        "",
        randomUnicode(rng, 8),
        rng.pick(TRAVERSAL_SLUGS),
        "A".repeat(4096),
      ]);
      const loneSurrogate = wtf8(token) !== token;
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      let note: string | undefined;
      const expected = token === ""
        ? "shape ok; decrypt → invalid_response (empty token guard)"
        : "shape ok; decrypt(same user) === token; decrypt(other user) → invalid_response";
      try {
        const encrypted = await encryptAppleRefreshToken(
          token,
          userId,
          VALID_KEY,
        );
        const shapeOk = shape.test(encrypted);
        const fitsDb = encrypted.length <= DB_CIPHERTEXT_CAP;
        let same: string;
        try {
          same = await decryptAppleRefreshToken(encrypted, userId, VALID_KEY);
        } catch (error) {
          const c = classifyError(error);
          same = `throw:${c.typed ? c.kind : "UNTYPED " + c.message}`;
        }
        const otherUser = rng.pick(
          [
            userId + " ",
            userId.toUpperCase(),
            userId.toLowerCase(),
            userId + "\u0000",
            userId.normalize("NFD"),
            userId.normalize("NFKC"),
            userId + "\u0301",
            "x" + userId,
          ].filter((candidate) => candidate !== userId),
        );
        let other: string;
        try {
          const forged = await decryptAppleRefreshToken(
            encrypted,
            otherUser,
            VALID_KEY,
          );
          other = `FORGED:${describeInput(forged, 30)}`;
        } catch (error) {
          const c = classifyError(error);
          other = c.typed ? c.kind : `UNTYPED ${c.message}`;
        }
        const roundTrip = token === ""
          ? same === "throw:invalid_response"
          : same === token;
        outcome =
          `shape=${shapeOk} len=${encrypted.length} fitsDbCap=${fitsDb} roundTrip=${roundTrip} otherUser=${other}`;
        if (!shapeOk || other !== "invalid_response") verdict = "BROKEN";
        if (!roundTrip) {
          verdict = "BROKEN";
          note = loneSurrogate
            ? "lone surrogate in token is replaced by U+FFFD on encode (lossy round trip; the token later sent to Apple differs)"
            : token.startsWith("\ufeff")
            ? `leading U+FEFF is stripped by TextDecoder on decrypt (lossy round trip): got ${
              describeInput(same, 60)
            }`
            : `round trip mismatch: got ${describeInput(same, 60)}`;
        }
        if (!fitsDb && verdict === "HELD") {
          note =
            `ciphertext ${encrypted.length} > ${DB_CIPHERTEXT_CAP}: upsert would fail the DB CHECK (token utf8 bytes=${
              new TextEncoder().encode(token).length
            })`;
        }
      } catch (error) {
        outcome = `encrypt threw ${errorSummary(error)}`;
        verdict = "BROKEN";
      }
      campaign.record({
        index,
        seed,
        input: `${tokenKind} token=${describeInput(token, 50)} uid=${
          describeInput(userId, 30)
        }`,
        outcome,
        expected,
        verdict,
        note,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    // Known defects (F2: lone surrogates, F3: leading U+FEFF) do not round-trip. Nothing else may break.
    const unexpected = report.rows.filter((r) =>
      r.verdict === "BROKEN" && !r.note?.includes("lone surrogate") &&
      !r.note?.includes("leading U+FEFF")
    );
    assertEquals(unexpected, []);
  },
});

Deno.test({
  name:
    `stress apple-exchange-response ×${STRESS_ITER}: malformed Apple token responses → typed error with truthful kind; code sent byte-exact`,
  ignore: !familySelected("apple-exchange-response"),
  async fn() {
    const campaign = new Campaign("apple-exchange-response", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const code = AUTH_CODE_POOL(rng);
      const reply = exchangeReply(rng);
      const calls: Recorded[] = [];
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      const expected = reply.expect === "grant"
        ? "grant returned"
        : `ExternalAccountError ${reply.expect}`;
      try {
        const grant = await exchangeAppleAuthorizationCode(
          code,
          CONFIG,
          stubFetch(reply.make, calls),
        );
        outcome = "grant returned";
        if (
          reply.expect !== "grant" ||
          grant.refreshToken !== reply.grant?.refreshToken ||
          grant.subject !== reply.grant?.subject
        ) {
          verdict = "BROKEN";
          outcome = `grant returned unexpectedly: ${describeInput(grant, 80)}`;
        }
      } catch (error) {
        const c = classifyError(error);
        outcome = c.typed
          ? `ExternalAccountError ${c.kind}`
          : `UNTYPED ${c.message}`;
        if (!c.typed || c.kind !== reply.expect) verdict = "BROKEN";
      }
      // Request shape: exactly one POST; the code round-trips byte-exact
      // (lone surrogates excepted — URLSearchParams encodes them as U+FFFD).
      const call = calls[0];
      const sentCode = call?.form?.get("code") ?? null;
      const codeMatches = sentCode === code || sentCode === wtf8(code);
      const secretShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
        .test(call?.form?.get("client_secret") ?? "");
      if (
        calls.length !== 1 || call.method !== "POST" || !codeMatches ||
        !secretShape || call.form?.get("grant_type") !== "authorization_code" ||
        call.url !== "https://appleid.apple.com/auth/token"
      ) {
        verdict = "BROKEN";
        outcome +=
          ` | request: n=${calls.length} codeMatches=${codeMatches} secretShape=${secretShape}`;
      }
      campaign.record({
        index,
        seed,
        input: `${reply.kind} code=${describeInput(code, 40)}`,
        outcome,
        expected,
        verdict,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

Deno.test({
  name:
    `stress apple-revoke-response ×${STRESS_ITER}: malformed Apple revoke responses → truthful kind; token sent byte-exact`,
  ignore: !familySelected("apple-revoke-response"),
  async fn() {
    const campaign = new Campaign("apple-revoke-response", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const token = rng.pick([
        randomAscii(rng, rng.int(1, 300)),
        randomUnicode(rng, 30),
        rng.pick(TRAVERSAL_SLUGS),
        "t\u0000ok",
        "x".repeat(65_536),
        "token&token_type_hint=access_token",
      ]);
      const reply = revokeReply(rng);
      const calls: Recorded[] = [];
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      const expected = reply.expect === "grant"
        ? "resolves"
        : `ExternalAccountError ${reply.expect}`;
      try {
        await revokeAppleRefreshToken(
          token,
          CONFIG,
          stubFetch(reply.make, calls),
        );
        outcome = "resolves";
        if (reply.expect !== "grant") verdict = "BROKEN";
      } catch (error) {
        const c = classifyError(error);
        outcome = c.typed
          ? `ExternalAccountError ${c.kind}`
          : `UNTYPED ${c.message}`;
        if (!c.typed || c.kind !== reply.expect) verdict = "BROKEN";
      }
      const call = calls[0];
      const sent = call?.form?.get("token") ?? null;
      const tokenMatches = sent === token || sent === wtf8(token);
      if (
        calls.length !== 1 || call.method !== "POST" || !tokenMatches ||
        call.form?.get("token_type_hint") !== "refresh_token" ||
        call.url !== "https://appleid.apple.com/auth/revoke"
      ) {
        verdict = "BROKEN";
        outcome += ` | request: n=${calls.length} tokenMatches=${tokenMatches}`;
      }
      campaign.record({
        index,
        seed,
        input: `${reply.kind} token=${describeInput(token, 40)}`,
        outcome,
        expected,
        verdict,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

// ─── family: revenuecat-delete ───────────────────────────────────────────────

Deno.test({
  name:
    `stress revenuecat-delete ×${STRESS_ITER}: ids with traversal/unicode/empty, secrets with CRLF/empty, odd statuses → typed error, URL stays under /v1/subscribers/<one segment>`,
  ignore: !familySelected("revenuecat-delete"),
  async fn() {
    const campaign = new Campaign("revenuecat-delete", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const idKind = rng.pick([
        "uuid",
        "traversal",
        "unicode",
        "empty",
        "whitespace",
        "huge",
        "nul",
        "grapheme",
        "query-injection",
        "percent-encoded",
      ]);
      const appUserId = {
        uuid: () => rng.uuid(),
        traversal: () => rng.pick(TRAVERSAL_SLUGS),
        unicode: () => randomUnicode(rng, 12),
        empty: () => "",
        whitespace: () => rng.pick([" ", "\t", "\n"]),
        huge: () => "u".repeat(65_536),
        nul: () => `${rng.uuid()}\u0000`,
        grapheme: () => rng.pick(GRAPHEME_CLUSTERS),
        "query-injection": () => `${rng.uuid()}?api_key=x&x=/../admin#frag`,
        "percent-encoded": () => "%2e%2e%2f%2e%2e%2fadmin",
      }[idKind]!();
      const secretKind = rng.pick([
        "valid",
        "empty",
        "whitespace",
        "crlf-injection",
        "trailing-newline",
        "unicode",
        "huge",
        "nul",
      ]);
      const secret = {
        valid: () => `sk_${randomAscii(rng, 32).replace(/[^A-Za-z0-9]/g, "a")}`,
        empty: () => "",
        whitespace: () => "  \t",
        "crlf-injection": () => `sk\r\nX-Injected: 1\r\n`,
        "trailing-newline": () => "sk_valid\n",
        unicode: () => randomUnicode(rng, 12),
        huge: () => "k".repeat(65_536),
        nul: () => "sk\u0000",
      }[secretKind]!();
      const status = rng.pick([
        200,
        204,
        404,
        400,
        401,
        403,
        409,
        422,
        429,
        500,
        502,
        503,
        301,
      ]);
      const throws = rng.bool(0.1);
      const calls: Recorded[] = [];
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      let note: string | undefined;
      const secretUsable = secret.trim() !== "";
      // Header values are ByteStrings: control chars, NUL and anything above
      // U+00FF make `new Request` throw inside fetch → typed `unavailable`.
      // deno-lint-ignore no-control-regex
      const headerSendable = !/[\u0000-\u001f\u007f\u0100-\uffff]/.test(
        secret.trim(),
      );
      const expected = !secretUsable
        ? "configuration, no request"
        : throws || !headerSendable
        ? "unavailable"
        : (status >= 200 && status < 300) || status === 404
        ? "resolves"
        : "unavailable";
      try {
        await deleteRevenueCatCustomer(
          appUserId,
          secret,
          stubFetch(() => {
            if (throws) throw new TypeError("network");
            return new Response(null, { status });
          }, calls),
        );
        outcome = "resolves";
        if (
          !secretUsable || throws ||
          !((status >= 200 && status < 300) || status === 404)
        ) verdict = "BROKEN";
      } catch (error) {
        const c = classifyError(error);
        outcome = c.typed
          ? `ExternalAccountError ${c.kind}`
          : `UNTYPED ${c.message}`;
        if (!c.typed) {
          verdict = "BROKEN";
          note =
            `untyped ${c.message} escapes deleteRevenueCatCustomer (encodeURIComponent on a lone surrogate)`;
        } else if (!secretUsable) {
          if (c.kind !== "configuration" || calls.length !== 0) {
            verdict = "BROKEN";
          }
        } else if (c.kind !== "unavailable") verdict = "BROKEN";
        else if (
          !throws && headerSendable &&
          ((status >= 200 && status < 300) || status === 404)
        ) verdict = "BROKEN";
      }
      if (secretUsable && calls.length === 1) {
        const url = new URL(calls[0].url);
        const segment = url.pathname.slice("/v1/subscribers/".length);
        const decoded = (() => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return null;
          }
        })();
        const authOk =
          calls[0].headers["authorization"] === `Bearer ${secret.trim()}`;
        const injected = Object.keys(calls[0].headers).some((h) =>
          h.toLowerCase() === "x-injected"
        );
        outcome += ` | url=${
          describeInput(url.pathname + url.search + url.hash, 60)
        } auth=${authOk} injected=${injected}`;
        if (
          !url.pathname.startsWith("/v1/subscribers/") ||
          segment.includes("/") || url.search !== "" || url.hash !== "" ||
          decoded !== appUserId || calls[0].method !== "DELETE" || injected
        ) {
          verdict = "BROKEN";
        }
        if (segment === "") {
          verdict = "BROKEN";
          note =
            "empty appUserId → DELETE on the subscriber COLLECTION URL (no guard)";
        }
      }
      campaign.record({
        index,
        seed,
        input: `id=${idKind} ${
          describeInput(appUserId, 30)
        } secret=${secretKind} status=${status} throws=${throws}`,
        outcome,
        expected,
        verdict,
        note,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    // Known defects (finding F3): empty appUserId is not refused; a lone
    // surrogate in appUserId escapes as an untyped URIError. Nothing else may break.
    const unexpected = report.rows.filter((r) =>
      r.verdict === "BROKEN" && !r.note?.includes("empty appUserId") &&
      !r.note?.includes("untyped URIError")
    );
    assertEquals(unexpected, []);
  },
});

// ─── family: apple-config-boundary ───────────────────────────────────────────
// Malformed operator secrets (PEM, ids). Oracle: `configuration` BEFORE any
// request leaves; the message must name the secret that is actually wrong.

Deno.test({
  name:
    `stress apple-config-boundary ×${STRESS_ITER}: malformed APPLE_SIGN_IN_* secrets → configuration before any request; message names the right secret`,
  ignore: !familySelected("apple-config-boundary"),
  async fn() {
    const campaign = new Campaign("apple-config-boundary", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const kind = rng.pick([
        "valid",
        "pem-empty",
        "pem-whitespace",
        "pem-headers-only",
        "pem-literal-backslash-n",
        "pem-no-headers",
        "pem-sec1-label",
        "pem-rsa",
        "pem-p384",
        "pem-truncated",
        "pem-nonbase64",
        "pem-crlf",
        "pem-huge-garbage",
        "pem-unicode",
        "pem-public-key-label",
        "ids-unicode",
        "ids-empty",
        "ids-huge",
        "ids-nul",
        "ids-newline",
      ]);
      const config: AppleServerConfiguration = { ...CONFIG };
      const body = P256_PEM.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
        .replace(/\s+/g, "");
      let expectConfigError = true;
      // When only the PEM is malformed, the diagnostic must talk about the
      // private key / configuration — never about APPLE_TOKEN_ENCRYPTION_KEY.
      let pemOnly = true;
      switch (kind) {
        case "valid":
          expectConfigError = false;
          pemOnly = false;
          break;
        case "pem-empty":
          config.privateKeyPem = "";
          break;
        case "pem-whitespace":
          config.privateKeyPem = " \n\t ";
          break;
        case "pem-headers-only":
          config.privateKeyPem =
            "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----";
          break;
        case "pem-literal-backslash-n":
          config.privateKeyPem = P256_PEM.replace(/\n/g, "\\n");
          expectConfigError = false; // privateKeyBytes un-escapes literal \n on purpose
          pemOnly = false;
          break;
        case "pem-no-headers":
          config.privateKeyPem = body;
          expectConfigError = false; // header stripping is best-effort; bare base64 imports fine
          pemOnly = false;
          break;
        case "pem-sec1-label":
          config.privateKeyPem = P256_PEM.replace(
            /PRIVATE KEY/g,
            "EC PRIVATE KEY",
          );
          break;
        case "pem-rsa":
          config.privateKeyPem = RSA_PEM;
          break;
        case "pem-p384":
          config.privateKeyPem = P384_PEM;
          break;
        case "pem-truncated":
          config.privateKeyPem = P256_PEM.slice(
            0,
            rng.int(30, P256_PEM.length - 30),
          );
          break;
        case "pem-nonbase64":
          config.privateKeyPem = P256_PEM.replace(/[A-Za-z0-9]/, "!");
          break;
        case "pem-crlf":
          config.privateKeyPem = P256_PEM.replace(/\n/g, "\r\n");
          expectConfigError = false;
          pemOnly = false;
          break;
        case "pem-huge-garbage":
          config.privateKeyPem = "A".repeat(65_536);
          break;
        case "pem-unicode":
          config.privateKeyPem = randomUnicode(rng, 200);
          break;
        case "pem-public-key-label":
          config.privateKeyPem = P256_PEM.replace(/PRIVATE KEY/g, "PUBLIC KEY");
          break;
        case "ids-unicode":
          config.clientId = randomUnicode(rng, 12).replace(LONE_SURROGATE, "x");
          config.teamId = randomUnicode(rng, 12).replace(LONE_SURROGATE, "x");
          config.keyId = randomUnicode(rng, 12).replace(LONE_SURROGATE, "x");
          expectConfigError = false;
          pemOnly = false;
          break;
        case "ids-empty":
          config.clientId = rng.bool() ? "" : "   ";
          pemOnly = false; // incomplete configuration is the right diagnosis
          break;
        case "ids-huge":
          config.keyId = "k".repeat(65_536);
          expectConfigError = false;
          pemOnly = false;
          break;
        case "ids-nul":
          config.teamId = "TEAM\u0000ID";
          expectConfigError = false;
          pemOnly = false;
          break;
        default:
          config.clientId = "com.picklesensei\r\nclient_secret=evil";
          expectConfigError = false;
          pemOnly = false;
      }
      const calls: Recorded[] = [];
      const useRevoke = rng.bool();
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      let note: string | undefined;
      const expected = expectConfigError
        ? `configuration, 0 requests${
          pemOnly ? ", message does not blame APPLE_TOKEN_ENCRYPTION_KEY" : ""
        }`
        : "request leaves with a signed client_secret";
      try {
        if (useRevoke) {
          await revokeAppleRefreshToken(
            "tok",
            config,
            stubFetch(() => new Response(null, { status: 200 }), calls),
          );
        } else {await exchangeAppleAuthorizationCode(
            "code",
            config,
            stubFetch(() =>
              jsonResponse(200, {
                refresh_token: "r",
                id_token: fakeJwt({ sub: "s" }, rng),
              }), calls),
          );}
        outcome = `resolved, requests=${calls.length}`;
        if (expectConfigError || calls.length !== 1) verdict = "BROKEN";
        else {
          const form = calls[0].form!;
          const secret = form.get("client_secret") ?? "";
          const parts = secret.split(".");
          if (parts.length !== 3 || form.get("client_id") !== config.clientId) {
            verdict = "BROKEN";
          } else {
            const header = JSON.parse(
              new TextDecoder().decode(decodeUrl(parts[0])),
            );
            const payload = JSON.parse(
              new TextDecoder().decode(decodeUrl(parts[1])),
            );
            if (
              header.kid !== config.keyId || payload.iss !== config.teamId ||
              payload.sub !== config.clientId
            ) verdict = "BROKEN";
          }
        }
      } catch (error) {
        const c = classifyError(error);
        outcome = c.typed
          ? `ExternalAccountError ${c.kind} "${c.message}" requests=${calls.length}`
          : `UNTYPED ${c.message}`;
        if (
          !c.typed || !expectConfigError || c.kind !== "configuration" ||
          calls.length !== 0
        ) verdict = "BROKEN";
        else if (pemOnly && c.message.includes("APPLE_TOKEN_ENCRYPTION_KEY")) {
          verdict = "BROKEN";
          note =
            `diagnostic names the wrong secret: "${c.message}" (only APPLE_SIGN_IN_PRIVATE_KEY was malformed)`;
        }
      }
      campaign.record({
        index,
        seed,
        input: `${kind} via ${useRevoke ? "revoke" : "exchange"}`,
        outcome,
        expected,
        verdict,
        note,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    // Known defect (finding F1, secondary): decodeBase64 blames APPLE_TOKEN_ENCRYPTION_KEY for a malformed PEM.
    const unexpected = report.rows.filter((r) =>
      r.verdict === "BROKEN" && !r.note?.includes("wrong secret")
    );
    assertEquals(unexpected, []);
  },
});

// ─── family: is-permanent-junk ───────────────────────────────────────────────

Deno.test({
  name:
    `stress is-permanent-junk ×${STRESS_ITER}: duck-typed/junk errors are never permanent; real kinds classify exactly`,
  ignore: !familySelected("is-permanent-junk"),
  fn() {
    const campaign = new Campaign("is-permanent-junk", FILE);
    for (const { index, seed } of seedsFor(campaign.family)) {
      const rng = new Prng(seed);
      const kindPick = rng.pick([
        "real",
        "duck",
        "error-with-kind",
        "junk",
        "null",
        "proto",
      ]);
      let value: unknown;
      let expected: boolean;
      let input: string;
      if (kindPick === "real") {
        const kind = rng.pick(
          [
            "configuration",
            "invalid_grant",
            "invalid_response",
            "unavailable",
          ] as const,
        );
        value = new ExternalAccountError(
          kind,
          rng.pick(["apple", "revenuecat"] as const),
          "m",
        );
        expected = kind === "invalid_grant" || kind === "invalid_response";
        input = `real ${kind}`;
      } else if (kindPick === "duck") {
        value = {
          kind: rng.pick(["invalid_grant", "invalid_response"]),
          provider: "apple",
          name: "ExternalAccountError",
          message: "m",
        };
        expected = false;
        input = `duck ${describeInput(value, 60)}`;
      } else if (kindPick === "error-with-kind") {
        const e = new Error("m") as Error & { kind?: string };
        e.kind = "invalid_grant";
        e.name = "ExternalAccountError";
        value = e;
        expected = false;
        input = "Error with kind=invalid_grant name=ExternalAccountError";
      } else if (kindPick === "junk") {
        value = rng.pick([
          wrongTypeValue(rng).value,
          randomUnicode(rng, 5),
          rng.pick(WEIRD_NUMBERS),
          undefined,
          Symbol("x"),
          () => "invalid_grant",
        ]);
        expected = false;
        input = `junk ${
          describeInput(
            typeof value === "symbol"
              ? "Symbol"
              : typeof value === "function"
              ? "function"
              : value,
            40,
          )
        }`;
      } else if (kindPick === "null") {
        value = null;
        expected = false;
        input = "null";
      } else {
        value = Object.create(ExternalAccountError.prototype); // prototype-chained but never constructed
        (value as { kind: string }).kind = "invalid_grant";
        expected = true; // instanceof holds; document the behaviour rather than assert otherwise
        input =
          "Object.create(ExternalAccountError.prototype) kind=invalid_grant";
      }
      let outcome: string;
      let verdict: "HELD" | "BROKEN" = "HELD";
      try {
        const result = isPermanentExternalAccountError(value);
        outcome = String(result);
        if (result !== expected) verdict = "BROKEN";
      } catch (error) {
        outcome = `THREW ${errorSummary(error)}`;
        verdict = "BROKEN";
      }
      campaign.record({
        index,
        seed,
        input,
        outcome,
        expected: String(expected),
        verdict,
      });
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

// Sanity: the fixtures themselves are sound (a broken fixture would make
// every "HELD" above meaningless).
Deno.test("stress fixtures: P-256 PEM signs, key encrypts/decrypts", async () => {
  const enc = await encryptAppleRefreshToken("fixture", USER_ID, VALID_KEY);
  assertEquals(
    await decryptAppleRefreshToken(enc, USER_ID, VALID_KEY),
    "fixture",
  );
  const calls: Recorded[] = [];
  await revokeAppleRefreshToken(
    "t",
    CONFIG,
    stubFetch(() => new Response(null, { status: 200 }), calls),
  );
  assert(calls[0].form?.get("client_secret")?.split(".").length === 3);
});
