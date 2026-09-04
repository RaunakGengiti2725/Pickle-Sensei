// Shared scenario generators for the externalAccounts.ts stress campaign.
// Pure functions of a seeded `Prng` so the module-level and handler-level
// planes fuzz the SAME input classes and any seed replays in either file.
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  b64url,
  describeInput,
  GRAPHEME_CLUSTERS,
  NORMALIZATION_PAIRS,
  Prng,
  PROTO_KEYS,
  randomAscii,
  randomUnicode,
  TRAVERSAL_SLUGS,
  WEIRD_NUMBERS,
  wrongTypeValue,
} from "./stress_external_accounts_gen.ts";

export const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** What URLSearchParams / TextEncoder send for a string with lone surrogates. */
export const wtf8 = (value: string): string =>
  value.replace(LONE_SURROGATE, "\ufffd");

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function fakeJwt(payload: unknown, rng: Prng): string {
  const header = b64url(
    new TextEncoder().encode(
      JSON.stringify({ alg: "RS256", kid: randomAscii(rng, 8) }),
    ),
  );
  const body = b64url(
    new TextEncoder().encode(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ),
  );
  return `${header}.${body}.${
    randomAscii(rng, 20).replace(/[^A-Za-z0-9]/g, "x")
  }`;
}

// ─── family: decrypt-stored-credential ───────────────────────────────────────
// Valid key, valid user; the STORED value is what varies. Oracle: only the
// untampered ciphertext decrypts; everything else throws a typed error whose
// kind is PERMANENT (a retry can never repair a corrupt stored credential).

export const DECRYPT_KINDS = [
  "untampered",
  "version",
  "segments",
  "iv-nonbase64",
  "iv-length",
  "ct-nonbase64",
  "ct-truncated",
  "ct-bitflip",
  "iv-bitflip",
  "unicode-segment",
  "traversal-segment",
  "huge-segment",
  "nul-segment",
  "whitespace-segment",
  "other-user-aad",
  "other-key",
  "random-text",
  "empty",
] as const;

export interface DecryptScenario {
  input: string;
  kind: string;
  encrypted: string;
  userId: string;
  key: string;
  expectPlaintext: string | null;
  token: string;
}

/** A stored-credential variant for `decryptAppleRefreshToken(encrypted, userId, key)`. */
export async function decryptScenario(
  rng: Prng,
  USER_ID: string,
  VALID_KEY: string,
  OTHER_KEY: string,
): Promise<DecryptScenario> {
  const token = rng.bool(0.7)
    ? randomAscii(rng, rng.int(1, 120))
    : randomUnicode(rng, rng.int(1, 40)).replace(/[\ud800-\udfff]/g, "x");
  const good = await encryptAppleRefreshToken(token, USER_ID, VALID_KEY);
  const [, iv, ct] = good.split(".");
  const kind = rng.pick(DECRYPT_KINDS);
  let encrypted = good;
  let userId = USER_ID;
  let key = VALID_KEY;
  let expectPlaintext: string | null = null;
  const flip = (segment: string): string => {
    const bytes = decodeUrl(segment);
    const at = rng.int(0, bytes.length - 1);
    bytes[at] ^= 1 << rng.int(0, 7);
    return b64url(bytes);
  };
  switch (kind) {
    case "untampered":
      expectPlaintext = token;
      break;
    case "version":
      encrypted = `${
        rng.pick([
          "v2",
          "V1",
          "v1 ",
          " v1",
          "v10",
          "v0",
          "",
          "v1\u0000",
          "v\u0661",
          "v1.",
          "vone",
          "1",
        ])
      }.${iv}.${ct}`;
      break;
    case "segments":
      encrypted = rng.pick([
        `v1.${iv}`,
        `v1.${iv}.${ct}.`,
        `v1.${iv}.${ct}.extra`,
        `v1..${ct}`,
        `v1.${iv}.`,
        "v1",
        "v1.",
        "v1..",
        "...",
        `v1.${iv}.${ct}.${ct}`,
      ]);
      break;
    case "iv-nonbase64":
      encrypted = `v1.${
        rng.pick([
          "!!!!",
          "AAAA*AAA",
          "AAAA=AAAA",
          "====",
          "AAAAAAAAAAAAAAA!",
          "AAAA AAAA",
          "Zm9v\tYmFy",
          "#" + iv,
        ])
      }.${ct}`;
      break;
    case "iv-length":
      encrypted = `v1.${
        b64url(rng.bytes(rng.pick([1, 2, 5, 8, 11, 13, 16, 32, 64, 256])))
      }.${ct}`;
      break;
    case "ct-nonbase64":
      encrypted = `v1.${iv}.${
        rng.pick([
          "abc!",
          "ab!cd",
          "abcde",
          "a",
          ct + "!",
          ct.slice(0, -1) + "*",
          ct + "===",
          ct.replace(/[A-Za-z]/, "%"),
        ])
      }`;
      break;
    case "ct-truncated":
      encrypted = `v1.${iv}.${
        b64url(
          decodeUrl(ct).slice(
            0,
            rng.int(0, Math.max(0, decodeUrl(ct).length - 1)),
          ),
        )
      }`;
      break;
    case "ct-bitflip":
      encrypted = `v1.${iv}.${flip(ct)}`;
      break;
    case "iv-bitflip":
      encrypted = `v1.${flip(iv)}.${ct}`;
      break;
    case "unicode-segment":
      encrypted = `v1.${
        rng.pick([
          randomUnicode(rng, 16),
          iv + rng.pick(GRAPHEME_CLUSTERS),
          rng.pick(NORMALIZATION_PAIRS)[rng.int(0, 1)].repeat(8),
        ])
      }.${ct}`;
      break;
    case "traversal-segment":
      encrypted = `v1.${rng.pick(TRAVERSAL_SLUGS)}.${ct}`;
      break;
    case "huge-segment":
      encrypted = rng.bool()
        ? `v1.${iv}.${"A".repeat(65_536 + rng.int(0, 3))}`
        : `v1.${"A".repeat(65_536)}.${ct}`;
      break;
    case "nul-segment":
      encrypted = `v1.${iv}\u0000.${ct}`;
      break;
    case "whitespace-segment":
      encrypted = rng.pick([
        ` v1.${iv}.${ct}`,
        `v1.${iv}.${ct} `,
        `v1. ${iv}.${ct}`,
        `v1.${iv} .${ct}`,
        `v1.${iv}.${ct}\n`,
      ]);
      break;
    case "other-user-aad":
      userId = rng.pick([
        `${USER_ID} `,
        ` ${USER_ID}`,
        USER_ID.slice(0, -1) + "2",
        USER_ID.replace(/-/g, ""),
        "",
        USER_ID + "\u0301",
        rng.uuid(),
        `${USER_ID}\u0000`,
        USER_ID.replace("4111", "4\u0661\u0661\u0661"), // Arabic-Indic digits
      ]);
      break;
    case "other-key":
      key = OTHER_KEY;
      break;
    case "random-text":
      encrypted = rng.pick([
        randomAscii(rng, rng.int(1, 200)),
        randomUnicode(rng, rng.int(1, 60)),
        "null",
        "undefined",
        "[object Object]",
        "{}",
        "[]",
        JSON.stringify({ v: 1, iv, ct }),
      ]);
      break;
    default:
      encrypted = "";
  }
  return {
    input: `${kind} ${describeInput(encrypted, 90)} uid=${
      describeInput(userId, 50)
    }`,
    kind,
    encrypted,
    userId,
    key,
    expectPlaintext,
    token,
  };
}

export function decodeUrl(segment: string): Uint8Array {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// ─── family: apple-exchange-response ─────────────────────────────────────────

export const AUTH_CODE_POOL = (rng: Prng): string =>
  rng.pick([
    randomAscii(rng, rng.int(1, 200)),
    randomUnicode(rng, rng.int(1, 40)),
    rng.pick(TRAVERSAL_SLUGS),
    "code&client_secret=evil&grant_type=refresh_token",
    "c\u0000ode",
    "x".repeat(4096),
    " padded ",
    rng.pick(GRAPHEME_CLUSTERS).repeat(3),
  ]);

export interface ProviderReply {
  kind: string;
  make: () => Response | Promise<Response>;
  /** what the oracle expects the function to do */
  expect: "grant" | "invalid_grant" | "invalid_response" | "unavailable";
  grant?: { refreshToken: string; subject: string };
}

export function exchangeReply(
  rng: Prng,
  subjectOverride?: string,
): ProviderReply {
  const refreshToken = randomAscii(rng, rng.int(1, 200));
  const subject = subjectOverride ?? rng.pick([
    `001234.${randomAscii(rng, 32).replace(/[^a-z0-9]/g, "a")}.0987`,
    randomUnicode(rng, 8),
    rng.uuid(),
  ]);
  const okStatus = rng.pick([200, 200, 200, 201, 299]);
  const errStatus = rng.pick([
    400,
    401,
    403,
    404,
    405,
    418,
    429,
    500,
    502,
    503,
    599,
    300,
    301,
  ]);
  const kind = rng.pick([
    "valid",
    "valid-extra-fields",
    "refresh-wrong-type",
    "refresh-empty",
    "refresh-whitespace",
    "refresh-missing",
    "idtoken-missing",
    "idtoken-wrong-type",
    "idtoken-not-jwt",
    "idtoken-two-segments",
    "idtoken-payload-not-json",
    "idtoken-payload-array",
    "idtoken-payload-null",
    "idtoken-sub-wrong-type",
    "idtoken-sub-empty",
    "idtoken-sub-whitespace",
    "idtoken-proto-key",
    "idtoken-sub-huge",
    "body-array",
    "body-null",
    "body-string",
    "body-number",
    "body-not-json",
    "body-empty",
    "body-truncated-json",
    "body-huge",
    "body-bom",
    "proto-top-level",
    "error-invalid_grant",
    "error-invalid_grant-2xx",
    "error-case-variant",
    "error-other-code",
    "error-wrong-type",
    "error-not-json",
    "error-empty",
    "error-nested",
    "fetch-throws-typeerror",
    "fetch-throws-string",
    "fetch-throws-abort",
    "response-error",
    "redirect-status",
  ]);
  const grant = { refreshToken, subject };
  const ok = (body: unknown, status = okStatus) => () =>
    jsonResponse(status, body);
  const idToken = (payload: unknown) => fakeJwt(payload, rng);
  switch (kind) {
    case "valid":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken({ sub: subject }),
        }),
        expect: "grant",
        grant,
      };
    case "valid-extra-fields":
      return {
        kind,
        make: ok({
          access_token: "a",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: refreshToken,
          id_token: idToken({
            sub: subject,
            iss: "https://appleid.apple.com",
            email_verified: "true",
          }),
          __proto__: { admin: true },
        }),
        expect: "grant",
        grant,
      };
    case "refresh-wrong-type":
      return {
        kind,
        make: ok({
          refresh_token: wrongTypeValue(rng).value,
          id_token: idToken({ sub: subject }),
        }),
        expect: "invalid_response",
      };
    case "refresh-empty":
      return {
        kind,
        make: ok({ refresh_token: "", id_token: idToken({ sub: subject }) }),
        expect: "invalid_response",
      };
    case "refresh-whitespace":
      return {
        kind,
        make: ok({
          refresh_token: rng.pick([" ", "\n\t", "\u00a0"]),
          id_token: idToken({ sub: subject }),
        }),
        expect: "invalid_response",
      };
    case "refresh-missing":
      return {
        kind,
        make: ok({ id_token: idToken({ sub: subject }) }),
        expect: "invalid_response",
      };
    case "idtoken-missing":
      return {
        kind,
        make: ok({ refresh_token: refreshToken }),
        expect: "invalid_response",
      };
    case "idtoken-wrong-type":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: wrongTypeValue(rng).value,
        }),
        expect: "invalid_response",
      };
    case "idtoken-not-jwt":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: rng.pick([
            "",
            "abc",
            "a.b",
            "...",
            "!!!.!!!.!!!",
            randomUnicode(rng, 20),
            "A".repeat(70_000),
          ]),
        }),
        expect: "invalid_response",
      };
    case "idtoken-two-segments": {
      const [h, p] = idToken({ sub: subject }).split(".");
      return {
        kind,
        make: ok({ refresh_token: refreshToken, id_token: `${h}.${p}` }),
        expect: "grant",
        grant,
      };
    }
    case "idtoken-payload-not-json":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken(rng.pick(["{not json", "sub=abc", "", "\u0000"])),
        }),
        expect: "invalid_response",
      };
    case "idtoken-payload-array":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken([{ sub: subject }]),
        }),
        expect: "invalid_response",
      };
    case "idtoken-payload-null":
      return {
        kind,
        make: ok({ refresh_token: refreshToken, id_token: idToken(null) }),
        expect: "invalid_response",
      };
    case "idtoken-sub-wrong-type":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken({ sub: wrongTypeValue(rng).value }),
        }),
        expect: "invalid_response",
      };
    case "idtoken-sub-empty":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken({ sub: "" }),
        }),
        expect: "invalid_response",
      };
    case "idtoken-sub-whitespace":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken({ sub: "  \t" }),
        }),
        expect: "invalid_response",
      };
    case "idtoken-proto-key":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken(
            `{"${rng.pick(PROTO_KEYS)}": {"sub": "${subject}"}}`,
          ),
        }),
        expect: "invalid_response",
      };
    case "idtoken-sub-huge":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken({ sub: "s".repeat(65_536) }),
        }),
        expect: "grant",
        grant: { refreshToken, subject: "s".repeat(65_536) },
      };
    case "body-array":
      return {
        kind,
        make: ok([{
          refresh_token: refreshToken,
          id_token: idToken({ sub: subject }),
        }]),
        expect: "invalid_response",
      };
    case "body-null":
      return { kind, make: ok(null), expect: "invalid_response" };
    case "body-string":
      return { kind, make: ok(refreshToken), expect: "invalid_response" };
    case "body-number":
      return {
        kind,
        make: ok(rng.pick(WEIRD_NUMBERS.filter((n) => Number.isFinite(n)))),
        expect: "invalid_response",
      };
    case "body-not-json":
      return {
        kind,
        make: () =>
          new Response(
            rng.pick([
              "<html>502</html>",
              "refresh_token=abc",
              "{",
              randomUnicode(rng, 40),
            ]),
            { status: okStatus },
          ),
        expect: "invalid_response",
      };
    case "body-empty":
      return {
        kind,
        make: () => new Response(null, { status: okStatus }),
        expect: "invalid_response",
      };
    case "body-truncated-json": {
      const full = JSON.stringify({
        refresh_token: refreshToken,
        id_token: idToken({ sub: subject }),
      });
      return {
        kind,
        make: () =>
          new Response(full.slice(0, rng.int(1, full.length - 1)), {
            status: okStatus,
          }),
        expect: "invalid_response",
      };
    }
    case "body-huge":
      return {
        kind,
        make: ok({
          refresh_token: refreshToken,
          id_token: idToken({ sub: subject }),
          pad: "p".repeat(2_000_000),
        }),
        expect: "grant",
        grant,
      };
    case "body-bom":
      return {
        kind,
        make: () =>
          new Response(
            "\ufeff" +
              JSON.stringify({
                refresh_token: refreshToken,
                id_token: idToken({ sub: subject }),
              }),
            { status: okStatus },
          ),
        expect: "invalid_response",
      };
    case "proto-top-level":
      return {
        kind,
        make: () =>
          new Response(
            `{"__proto__": {"refresh_token": "${refreshToken}", "id_token": "${
              idToken({ sub: subject })
            }"}}`,
            { status: okStatus },
          ),
        expect: "invalid_response",
      };
    case "error-invalid_grant":
      return {
        kind,
        make: () =>
          jsonResponse(errStatus >= 400 ? errStatus : 400, {
            error: "invalid_grant",
          }),
        expect: "invalid_grant",
      };
    case "error-invalid_grant-2xx":
      return {
        kind,
        make: ok({ error: "invalid_grant" }),
        expect: "invalid_response",
      };
    case "error-case-variant":
      return {
        kind,
        make: () =>
          jsonResponse(400, {
            error: rng.pick([
              "Invalid_Grant",
              "INVALID_GRANT",
              "invalid_grant ",
              " invalid_grant",
              "invalid-grant",
              "invalid_grant\u0000",
            ]),
          }),
        expect: "unavailable",
      };
    case "error-other-code":
      return {
        kind,
        make: () =>
          jsonResponse(rng.pick([400, 401]), {
            error: rng.pick([
              "invalid_client",
              "invalid_request",
              "unsupported_grant_type",
              "invalid_scope",
              "unauthorized_client",
              randomAscii(rng, 12),
            ]),
          }),
        expect: "unavailable",
      };
    case "error-wrong-type":
      return {
        kind,
        make: () => jsonResponse(400, { error: wrongTypeValue(rng).value }),
        expect: "unavailable",
      };
    case "error-not-json":
      return {
        kind,
        make: () =>
          new Response(rng.pick(["<html>", "invalid_grant", "{", ""]), {
            status: errStatus >= 400 ? errStatus : 400,
          }),
        expect: "unavailable",
      };
    case "error-empty":
      return {
        kind,
        make: () =>
          new Response(null, { status: errStatus >= 400 ? errStatus : 400 }),
        expect: "unavailable",
      };
    case "error-nested":
      return {
        kind,
        make: () =>
          jsonResponse(400, {
            error: { code: "invalid_grant" },
            invalid_grant: true,
          }),
        expect: "unavailable",
      };
    case "fetch-throws-typeerror":
      return {
        kind,
        make: () => {
          throw new TypeError("network");
        },
        expect: "unavailable",
      };
    case "fetch-throws-string":
      // deno-lint-ignore no-throw-literal
      return {
        kind,
        make: () => {
          throw "boom";
        },
        expect: "unavailable",
      };
    case "fetch-throws-abort":
      return {
        kind,
        make: () => {
          throw new DOMException("aborted", "AbortError");
        },
        expect: "unavailable",
      };
    case "response-error":
      return { kind, make: () => Response.error(), expect: "unavailable" };
    default:
      return {
        kind,
        make: () =>
          new Response(null, { status: rng.pick([300, 301, 302, 304, 307]) }),
        expect: "unavailable",
      };
  }
}

// ─── family: apple-revoke-response ───────────────────────────────────────────

export function revokeReply(rng: Prng): ProviderReply {
  const kind = rng.pick([
    "ok-200",
    "ok-2xx-body",
    "ok-200-error-body",
    "error-invalid_grant",
    "error-case-variant",
    "error-other-code",
    "error-wrong-type",
    "error-not-json",
    "error-empty",
    "error-5xx",
    "error-429",
    "error-nested",
    "proto-error",
    "fetch-throws",
    "fetch-throws-nonerror",
    "response-error",
    "redirect",
  ]);
  switch (kind) {
    case "ok-200":
      return {
        kind,
        make: () => new Response(null, { status: 200 }),
        expect: "grant",
      };
    case "ok-2xx-body":
      return {
        kind,
        make: () =>
          new Response(rng.pick(["{}", "ok", "<html>", "\u0000"]), {
            status: rng.pick([200, 202, 299]),
          }),
        expect: "grant",
      };
    case "ok-200-error-body":
      return {
        kind,
        make: () => jsonResponse(200, { error: "invalid_grant" }),
        expect: "grant",
      };
    case "error-invalid_grant":
      return {
        kind,
        make: () =>
          jsonResponse(rng.pick([400, 401, 403, 500]), {
            error: "invalid_grant",
          }),
        expect: "invalid_grant",
      };
    case "error-case-variant":
      return {
        kind,
        make: () =>
          jsonResponse(400, {
            error: rng.pick([
              "Invalid_Grant",
              "invalid_grant ",
              "invalid-grant",
            ]),
          }),
        expect: "unavailable",
      };
    case "error-other-code":
      return {
        kind,
        make: () =>
          jsonResponse(400, {
            error: rng.pick([
              "invalid_client",
              "invalid_request",
              "unauthorized_client",
              "unsupported_grant_type",
              "invalid_scope",
            ]),
          }),
        expect: "unavailable",
      };
    case "error-wrong-type":
      return {
        kind,
        make: () => jsonResponse(400, { error: wrongTypeValue(rng).value }),
        expect: "unavailable",
      };
    case "error-not-json":
      return {
        kind,
        make: () =>
          new Response(rng.pick(["invalid_grant", "{", "<html>"]), {
            status: 400,
          }),
        expect: "unavailable",
      };
    case "error-empty":
      return {
        kind,
        make: () => new Response(null, { status: rng.pick([400, 404, 410]) }),
        expect: "unavailable",
      };
    case "error-5xx":
      return {
        kind,
        make: () =>
          new Response("upstream", { status: rng.pick([500, 502, 503, 504]) }),
        expect: "unavailable",
      };
    case "error-429":
      return {
        kind,
        make: () =>
          new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
        expect: "unavailable",
      };
    case "error-nested":
      return {
        kind,
        make: () => jsonResponse(400, { error: { error: "invalid_grant" } }),
        expect: "unavailable",
      };
    case "proto-error":
      return {
        kind,
        make: () =>
          new Response('{"__proto__": {"error": "invalid_grant"}}', {
            status: 400,
          }),
        expect: "unavailable",
      };
    case "fetch-throws":
      return {
        kind,
        make: () => {
          throw new TypeError("connection reset");
        },
        expect: "unavailable",
      };
    case "fetch-throws-nonerror":
      // deno-lint-ignore no-throw-literal
      return {
        kind,
        make: () => {
          throw { code: "ECONNRESET" };
        },
        expect: "unavailable",
      };
    case "response-error":
      return { kind, make: () => Response.error(), expect: "unavailable" };
    default:
      return {
        kind,
        make: () => new Response(null, { status: rng.pick([301, 302, 307]) }),
        expect: "unavailable",
      };
  }
}
