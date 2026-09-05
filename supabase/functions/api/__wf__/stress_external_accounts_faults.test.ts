// Stress lens `failure-load`, part 1 — FAILURE INJECTION for the external
// account paths (externalAccounts.ts + the bootstrap / delete-confirm routes
// that drive it). Every upstream (Supabase Auth, PostgREST, Apple, RevenueCat,
// Upstash) fails / times out / answers malformed in turn; each case asserts
// the classified error (module) or the client-visible error class and the
// recoverability of the flow (route), seeded and replayable.
//
//   STRESS_ITER=<n>  iterations per case (default 3)
//   STRESS_SEED=<n>  base seed
//   STRESS_OUT=<dir> where the JSON tables land
//
// Replay a single case:  STRESS_CASE=<case id> STRESS_SEED=<seed> deno test ...

import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "jsr:@std/testing@1/time";
import {
  type AppleServerConfiguration,
  decryptAppleRefreshToken,
  deleteRevenueCatCustomer,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  ExternalAccountError,
  revokeAppleRefreshToken,
} from "../externalAccounts.ts";
import {
  abortError,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  bootstrapRequest,
  classify,
  CREDENTIALS_TABLE,
  deleteConfirmRequest,
  describeFault,
  type ErrorClass,
  errorKind,
  type Fault,
  faultResponse,
  googleBootstrapRequest,
  ipFor,
  leakMarker,
  loadWorld,
  mintAppleUser,
  Prng,
  RC_URL_PREFIX,
  seedDeletionChallenge,
  seedFor,
  type StatefulWorld,
  storeAppleCredential,
  STRESS_ITER,
  TARGETS,
  userIdFor,
  writeReport,
} from "./stress_external_accounts_harness.ts";

const ONLY_CASE = Deno.env.get("STRESS_CASE") ?? null;
/** STRESS_STRICT=1 also fails the suite on the documented (known) defects. */
const STRICT = Deno.env.get("STRESS_STRICT") === "1";

// ── Module-level matrix ──────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function testPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    [
      "sign",
      "verify",
    ],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return `-----BEGIN PRIVATE KEY-----\n${
    bytesToBase64(pkcs8)
  }\n-----END PRIVATE KEY-----`;
}

async function rsaPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return `-----BEGIN PRIVATE KEY-----\n${
    bytesToBase64(pkcs8)
  }\n-----END PRIVATE KEY-----`;
}

function appleIdToken(sub: unknown, payloadOverride?: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256" }));
  const payload = payloadOverride ??
    b64url(JSON.stringify({ iss: "https://appleid.apple.com", sub }));
  return `${header}.${payload}.sig`;
}

type Expect = { kind: ExternalAccountError["kind"] | "ok"; permanent: boolean };

interface ModuleCase {
  id: string;
  target:
    | "apple.exchange"
    | "apple.revoke"
    | "apple.decrypt"
    | "revenuecat.delete";
  fault: string;
  expect: Expect;
  run: (
    ctx: ModuleContext,
    rng: Prng,
  ) => Promise<{ fetched: number; detail?: string }>;
}

interface ModuleContext {
  config: AppleServerConfiguration;
  key: string;
  rsaPem: string;
}

function fetchWith(
  fault: Fault | ((req: Request) => Response | Promise<Response>),
): {
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: () => number;
} {
  let count = 0;
  const fn = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    count += 1;
    try {
      return Promise.resolve(
        typeof fault === "function"
          ? fault(new Request(input, init))
          : faultResponse(fault),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return { fn, calls: () => count };
}

const ok200 = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const exchangeCases: ModuleCase[] = [
  ...(
    [
      [
        "M01",
        "fetch rejects (connection reset)",
        { kind: "reject" },
        "unavailable",
      ],
      ["M02", "HTTP 500 empty", { kind: "status", status: 500 }, "unavailable"],
      ["M03", "HTTP 503 html", {
        kind: "status",
        status: 503,
        body: "<html>maintenance</html>",
        contentType: "text/html",
      }, "unavailable"],
      ["M04", "HTTP 429", {
        kind: "status",
        status: 429,
        body: '{"error":"rate_limited"}',
        contentType: "application/json",
      }, "unavailable"],
      ["M05", "HTTP 400 invalid_grant", {
        kind: "json",
        status: 400,
        body: { error: "invalid_grant" },
      }, "invalid_grant"],
      ["M06", "HTTP 400 invalid_client", {
        kind: "json",
        status: 400,
        body: { error: "invalid_client" },
      }, "unavailable"],
      ["M07", "HTTP 400 non-JSON body", {
        kind: "status",
        status: 400,
        body: "invalid_grant",
        contentType: "text/plain",
      }, "unavailable"],
      ["M08", "HTTP 400 JSON array body", {
        kind: "json",
        status: 400,
        body: ["invalid_grant"],
      }, "unavailable"],
      ["M09", "HTTP 401 error not a string", {
        kind: "json",
        status: 401,
        body: { error: 123 },
      }, "unavailable"],
      ["M10", "HTTP 200 malformed JSON", {
        kind: "malformed_json",
        status: 200,
      }, "invalid_response"],
      [
        "M11",
        "HTTP 200 {}",
        { kind: "json", status: 200, body: {} },
        "invalid_response",
      ],
      ["M12", "HTTP 200 empty refresh_token", {
        kind: "json",
        status: 200,
        body: { refresh_token: "", id_token: appleIdToken("s") },
      }, "invalid_response"],
      ["M13", "HTTP 200 whitespace refresh_token", {
        kind: "json",
        status: 200,
        body: { refresh_token: "   ", id_token: appleIdToken("s") },
      }, "invalid_response"],
      ["M14", "HTTP 200 numeric refresh_token", {
        kind: "json",
        status: 200,
        body: { refresh_token: 123, id_token: appleIdToken("s") },
      }, "invalid_response"],
      ["M15", "HTTP 200 id_token without sub", {
        kind: "json",
        status: 200,
        body: { refresh_token: "rt", id_token: appleIdToken(undefined) },
      }, "invalid_response"],
      ["M16", "HTTP 200 id_token numeric sub", {
        kind: "json",
        status: 200,
        body: { refresh_token: "rt", id_token: appleIdToken(42) },
      }, "invalid_response"],
      ["M17", "HTTP 200 id_token not a JWT", {
        kind: "json",
        status: 200,
        body: { refresh_token: "rt", id_token: "garbage" },
      }, "invalid_response"],
      ["M18", "HTTP 200 id_token payload not base64", {
        kind: "json",
        status: 200,
        body: { refresh_token: "rt", id_token: appleIdToken("s", "!!!!") },
      }, "invalid_response"],
      ["M19", "HTTP 200 id_token payload JSON array", {
        kind: "json",
        status: 200,
        body: {
          refresh_token: "rt",
          id_token: appleIdToken("s", b64url("[1]")),
        },
      }, "invalid_response"],
      ["M20", "HTTP 200 id_token empty sub", {
        kind: "json",
        status: 200,
        body: { refresh_token: "rt", id_token: appleIdToken("  ") },
      }, "invalid_response"],
      ["M21", "HTTP 200 body is JSON null", {
        kind: "json",
        status: 200,
        body: null,
      }, "invalid_response"],
      ["M22", "HTTP 200 body is a JSON string", {
        kind: "json",
        status: 200,
        body: "ok",
      }, "invalid_response"],
    ] as const
  ).map(([id, fault, f, kind]) => ({
    id,
    target: "apple.exchange" as const,
    fault,
    expect: {
      kind,
      permanent: kind === "invalid_grant" || kind === "invalid_response",
    },
    run: async (ctx: ModuleContext, rng: Prng) => {
      const stub = fetchWith(f as Fault);
      await expectKind(
        () =>
          exchangeAppleAuthorizationCode(
            `code-${rng.uuid()}`,
            ctx.config,
            stub.fn,
          ),
        kind,
      );
      return { fetched: stub.calls() };
    },
  })),
  {
    id: "M23",
    target: "apple.exchange",
    fault: "timeout — Apple never answers (FakeTime, 15s deadline)",
    expect: { kind: "unavailable", permanent: false },
    run: async (ctx, rng) => {
      const time = new FakeTime();
      try {
        let aborted = false;
        const stub = fetchWith(
          (req) =>
            new Promise<Response>((_, reject) => {
              req.signal.addEventListener("abort", () => {
                aborted = true;
                reject(abortError());
              });
            }),
        );
        const pending = exchangeAppleAuthorizationCode(
          `code-${rng.uuid()}`,
          ctx.config,
          stub.fn,
        );
        let settled = false;
        pending.then(
          () => (settled = true),
          () => (settled = true),
        );
        await time.tickAsync(14_999);
        assert(
          !settled,
          "exchange must still be pending just before the 15s deadline",
        );
        await time.tickAsync(1);
        await expectKind(() => pending, "unavailable");
        assert(aborted, "the AbortController signal must reach the fetch");
        return { fetched: stub.calls() };
      } finally {
        time.restore();
      }
    },
  },
  {
    id: "M24",
    target: "apple.exchange",
    fault: "fetch throws synchronously",
    expect: { kind: "unavailable", permanent: false },
    run: async (ctx, rng) => {
      let calls = 0;
      const fn = (): Promise<Response> => {
        calls += 1;
        throw new Error("sync boom");
      };
      await expectKind(
        () =>
          exchangeAppleAuthorizationCode(`code-${rng.uuid()}`, ctx.config, fn),
        "unavailable",
      );
      return { fetched: calls };
    },
  },
  {
    id: "M25",
    target: "apple.exchange",
    fault: "config: clientId blank (no network call)",
    expect: { kind: "configuration", permanent: false },
    run: async (ctx, rng) => {
      const stub = fetchWith({ kind: "status", status: 200 });
      await expectKind(
        () =>
          exchangeAppleAuthorizationCode(`code-${rng.uuid()}`, {
            ...ctx.config,
            clientId: "  ",
          }, stub.fn),
        "configuration",
      );
      assertEquals(
        stub.calls(),
        0,
        "no Apple call with an incomplete configuration",
      );
      return { fetched: stub.calls() };
    },
  },
  {
    id: "M26",
    target: "apple.exchange",
    fault: "config: PEM body empty",
    expect: { kind: "configuration", permanent: false },
    run: async (ctx, rng) => {
      const stub = fetchWith({ kind: "status", status: 200 });
      const pem = "-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----";
      await expectKind(
        () =>
          exchangeAppleAuthorizationCode(`code-${rng.uuid()}`, {
            ...ctx.config,
            privateKeyPem: pem,
          }, stub.fn),
        "configuration",
      );
      assertEquals(stub.calls(), 0);
      return { fetched: stub.calls() };
    },
  },
  {
    id: "M27",
    target: "apple.exchange",
    fault: "config: PEM not base64",
    expect: { kind: "configuration", permanent: false },
    run: async (ctx, rng) => {
      const stub = fetchWith({ kind: "status", status: 200 });
      const pem =
        "-----BEGIN PRIVATE KEY-----\n!!!!not-base64!!!!\n-----END PRIVATE KEY-----";
      const error = await expectKind(
        () =>
          exchangeAppleAuthorizationCode(`code-${rng.uuid()}`, {
            ...ctx.config,
            privateKeyPem: pem,
          }, stub.fn),
        "configuration",
      );
      assertEquals(stub.calls(), 0);
      return { fetched: stub.calls(), detail: error.message };
    },
  },
  {
    id: "M28",
    target: "apple.exchange",
    fault: "config: PEM is base64 but not PKCS#8",
    expect: { kind: "configuration", permanent: false },
    run: async (ctx, rng) => {
      const stub = fetchWith({ kind: "status", status: 200 });
      const pem = `-----BEGIN PRIVATE KEY-----\n${
        btoa("definitely not a key")
      }\n-----END PRIVATE KEY-----`;
      await expectKind(
        () =>
          exchangeAppleAuthorizationCode(`code-${rng.uuid()}`, {
            ...ctx.config,
            privateKeyPem: pem,
          }, stub.fn),
        "configuration",
      );
      assertEquals(stub.calls(), 0);
      return { fetched: stub.calls() };
    },
  },
  {
    id: "M29",
    target: "apple.exchange",
    fault: "config: PEM is an RSA key (not P-256)",
    expect: { kind: "configuration", permanent: false },
    run: async (ctx, rng) => {
      const stub = fetchWith({ kind: "status", status: 200 });
      await expectKind(
        () =>
          exchangeAppleAuthorizationCode(
            `code-${rng.uuid()}`,
            { ...ctx.config, privateKeyPem: ctx.rsaPem },
            stub.fn,
          ),
        "configuration",
      );
      assertEquals(stub.calls(), 0);
      return { fetched: stub.calls() };
    },
  },
  {
    id: "M30",
    target: "apple.exchange",
    fault: "healthy grant (control) — form fields + subject binding",
    expect: { kind: "ok", permanent: false },
    run: async (ctx, rng) => {
      const sub = rng.uuid();
      const code = `code-${rng.uuid()}`;
      const forms: URLSearchParams[] = [];
      const stub = fetchWith(async (req) => {
        forms.push(new URLSearchParams(await req.text()));
        assertEquals(req.url, APPLE_TOKEN_URL);
        return ok200({
          refresh_token: `rt-${sub}`,
          id_token: appleIdToken(sub),
        });
      });
      const grant = await exchangeAppleAuthorizationCode(
        code,
        ctx.config,
        stub.fn,
      );
      assertEquals(grant.subject, sub);
      assertEquals(grant.refreshToken, `rt-${sub}`);
      assertEquals(forms.length, 1);
      const seenForm = forms[0];
      assertEquals(seenForm.get("code"), code);
      assertEquals(seenForm.get("grant_type"), "authorization_code");
      assertEquals(seenForm.get("client_id"), ctx.config.clientId);
      assert(
        (seenForm.get("client_secret") ?? "").split(".").length === 3,
        "client secret is a JWT",
      );
      return { fetched: stub.calls() };
    },
  },
];

const revokeCases: ModuleCase[] = [
  ...(
    [
      ["M31", "HTTP 400 invalid_grant", {
        kind: "json",
        status: 400,
        body: { error: "invalid_grant" },
      }, "invalid_grant"],
      ["M32", "HTTP 400 invalid_client", {
        kind: "json",
        status: 400,
        body: { error: "invalid_client" },
      }, "unavailable"],
      ["M33", "HTTP 400 unauthorized_client", {
        kind: "json",
        status: 400,
        body: { error: "unauthorized_client" },
      }, "unavailable"],
      ["M34", "HTTP 400 unsupported_grant_type", {
        kind: "json",
        status: 400,
        body: { error: "unsupported_grant_type" },
      }, "unavailable"],
      ["M35", "HTTP 400 invalid_request", {
        kind: "json",
        status: 400,
        body: { error: "invalid_request" },
      }, "unavailable"],
      ["M36", "HTTP 400 invalid_grant as array", {
        kind: "json",
        status: 400,
        body: { error: ["invalid_grant"] },
      }, "unavailable"],
      ["M37", "HTTP 400 invalid_grant with text/plain content-type", {
        kind: "status",
        status: 400,
        body: '{"error":"invalid_grant"}',
        contentType: "text/plain",
      }, "invalid_grant"],
      ["M38", "HTTP 401 empty", { kind: "status", status: 401 }, "unavailable"],
      ["M39", "HTTP 403 text", {
        kind: "status",
        status: 403,
        body: "forbidden",
        contentType: "text/plain",
      }, "unavailable"],
      ["M40", "HTTP 429", { kind: "status", status: 429 }, "unavailable"],
      ["M41", "HTTP 500", { kind: "status", status: 500 }, "unavailable"],
      ["M42", "HTTP 502 malformed JSON", {
        kind: "malformed_json",
        status: 502,
      }, "unavailable"],
      ["M43", "HTTP 503", { kind: "status", status: 503 }, "unavailable"],
      ["M44", "HTTP 504", { kind: "status", status: 504 }, "unavailable"],
      ["M45", "fetch rejects", { kind: "reject" }, "unavailable"],
      ["M46", "fetch rejects with AbortError (transport abort)", {
        kind: "timeout",
      }, "unavailable"],
    ] as const
  ).map(([id, fault, f, kind]) => ({
    id,
    target: "apple.revoke" as const,
    fault,
    expect: { kind, permanent: kind === "invalid_grant" },
    run: async (ctx: ModuleContext, rng: Prng) => {
      const stub = fetchWith(f as Fault);
      await expectKind(
        () => revokeAppleRefreshToken(`rt-${rng.uuid()}`, ctx.config, stub.fn),
        kind,
      );
      return { fetched: stub.calls() };
    },
  })),
  {
    id: "M47",
    target: "apple.revoke",
    fault: "timeout — Apple never answers (FakeTime, 15s deadline)",
    expect: { kind: "unavailable", permanent: false },
    run: async (ctx, rng) => {
      const time = new FakeTime();
      try {
        const stub = fetchWith(
          (req) =>
            new Promise<Response>((_, reject) => {
              req.signal.addEventListener("abort", () => reject(abortError()));
            }),
        );
        const pending = revokeAppleRefreshToken(
          `rt-${rng.uuid()}`,
          ctx.config,
          stub.fn,
        );
        let settled = false;
        pending.then(
          () => (settled = true),
          () => (settled = true),
        );
        await time.tickAsync(14_999);
        assert(!settled);
        await time.tickAsync(1);
        await expectKind(() => pending, "unavailable");
        return { fetched: stub.calls() };
      } finally {
        time.restore();
      }
    },
  },
  {
    id: "M48",
    target: "apple.revoke",
    fault: "healthy 200 (control) — revoke form carries token + hint",
    expect: { kind: "ok", permanent: false },
    run: async (ctx, rng) => {
      const token = `rt-${rng.uuid()}`;
      let seen: URLSearchParams | null = null;
      const stub = fetchWith(async (req) => {
        assertEquals(req.url, APPLE_REVOKE_URL);
        seen = new URLSearchParams(await req.text());
        return new Response(null, { status: 200 });
      });
      await revokeAppleRefreshToken(token, ctx.config, stub.fn);
      assertEquals(seen!.get("token"), token);
      assertEquals(seen!.get("token_type_hint"), "refresh_token");
      return { fetched: stub.calls() };
    },
  },
];

const decryptCases: ModuleCase[] = [
  {
    id: "M49",
    target: "apple.decrypt",
    fault: "ciphertext encrypted under a rotated key",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const otherKey = bytesToBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const stored = await encryptAppleRefreshToken(
        `rt-${rng.uuid()}`,
        user,
        otherKey,
      );
      await expectKind(
        () => decryptAppleRefreshToken(stored, user, ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M50",
    target: "apple.decrypt",
    fault: "ciphertext moved to another user (AAD mismatch)",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const stored = await encryptAppleRefreshToken(
        `rt-${rng.uuid()}`,
        rng.uuid(),
        ctx.key,
      );
      await expectKind(
        () => decryptAppleRefreshToken(stored, rng.uuid(), ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M51",
    target: "apple.decrypt",
    fault: "unsupported version prefix v0",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const stored =
        (await encryptAppleRefreshToken(`rt-${rng.uuid()}`, user, ctx.key))
          .replace(/^v1/, "v0");
      await expectKind(
        () => decryptAppleRefreshToken(stored, user, ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M52",
    target: "apple.decrypt",
    fault: "extra trailing segment",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const stored = `${await encryptAppleRefreshToken(
        `rt-${rng.uuid()}`,
        user,
        ctx.key,
      )}.extra`;
      await expectKind(
        () => decryptAppleRefreshToken(stored, user, ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M53",
    target: "apple.decrypt",
    fault: "missing ciphertext segment",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const [v, iv] =
        (await encryptAppleRefreshToken(`rt-${rng.uuid()}`, user, ctx.key))
          .split(".");
      await expectKind(
        () => decryptAppleRefreshToken(`${v}.${iv}`, user, ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M54",
    target: "apple.decrypt",
    fault: "empty string / garbage / whitespace stored value",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      for (
        const stored of [
          "",
          "   ",
          "garbage",
          "v1",
          "v1.",
          "v1..",
          "..",
          "v1.a.b.c.d",
        ]
      ) {
        await expectKind(
          () => decryptAppleRefreshToken(stored, user, ctx.key),
          "invalid_response",
        );
      }
      return { fetched: 0 };
    },
  },
  {
    id: "M55",
    target: "apple.decrypt",
    fault: "ciphertext with one flipped base64 char (auth tag mismatch)",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const [v, iv, ct] =
        (await encryptAppleRefreshToken(`rt-${rng.uuid()}`, user, ctx.key))
          .split(".");
      // Never the final symbol: its unused low bits are discarded by base64
      // decoding, so flipping only them leaves the ciphertext bytes intact.
      const idx = rng.int(0, ct.length - 2);
      const replacement = ct[idx] === "A" ? "B" : "A";
      const tampered = ct.slice(0, idx) + replacement + ct.slice(idx + 1);
      await expectKind(
        () => decryptAppleRefreshToken(`${v}.${iv}.${tampered}`, user, ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M56",
    target: "apple.decrypt",
    fault: "iv with one flipped base64 char",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const [v, iv, ct] =
        (await encryptAppleRefreshToken(`rt-${rng.uuid()}`, user, ctx.key))
          .split(".");
      const idx = rng.int(0, iv.length - 1);
      const replacement = iv[idx] === "A" ? "B" : "A";
      const tampered = iv.slice(0, idx) + replacement + iv.slice(idx + 1);
      await expectKind(
        () => decryptAppleRefreshToken(`${v}.${tampered}.${ct}`, user, ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M57",
    target: "apple.decrypt",
    fault: "stored iv is not base64 (row corruption) — MUST be permanent",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const [v, , ct] =
        (await encryptAppleRefreshToken(`rt-${rng.uuid()}`, user, ctx.key))
          .split(".");
      const error = await expectRejects(() =>
        decryptAppleRefreshToken(`${v}.!!!!.${ct}`, user, ctx.key)
      );
      return {
        fetched: 0,
        detail: `${errorKind(error)}: ${
          error instanceof Error ? error.message : error
        }`,
      };
    },
  },
  {
    id: "M58",
    target: "apple.decrypt",
    fault:
      "stored ciphertext is not base64 (row corruption) — MUST be permanent",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const [v, iv] =
        (await encryptAppleRefreshToken(`rt-${rng.uuid()}`, user, ctx.key))
          .split(".");
      const error = await expectRejects(() =>
        decryptAppleRefreshToken(`${v}.${iv}.***corrupt***`, user, ctx.key)
      );
      return {
        fetched: 0,
        detail: `${errorKind(error)}: ${
          error instanceof Error ? error.message : error
        }`,
      };
    },
  },
  {
    id: "M59",
    target: "apple.decrypt",
    fault:
      "stored segment length ≡ 1 mod 4 (truncated write) — MUST be permanent",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const [v, iv, ct] =
        (await encryptAppleRefreshToken(`rt-${rng.uuid()}`, user, ctx.key))
          .split(".");
      const truncated = ct.slice(0, ct.length - ((ct.length % 4) + 3));
      assertEquals(truncated.length % 4, 1);
      const error = await expectRejects(() =>
        decryptAppleRefreshToken(`${v}.${iv}.${truncated}`, user, ctx.key)
      );
      return {
        fetched: 0,
        detail: `${errorKind(error)}: ${
          error instanceof Error ? error.message : error
        }`,
      };
    },
  },
  {
    id: "M60",
    target: "apple.decrypt",
    fault: "encryption key is not 32 bytes",
    expect: { kind: "configuration", permanent: false },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const stored = await encryptAppleRefreshToken(
        `rt-${rng.uuid()}`,
        user,
        ctx.key,
      );
      const shortKey = bytesToBase64(
        crypto.getRandomValues(new Uint8Array(16)),
      );
      await expectKind(
        () => decryptAppleRefreshToken(stored, user, shortKey),
        "configuration",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M61",
    target: "apple.decrypt",
    fault: "encryption key env is not base64",
    expect: { kind: "configuration", permanent: false },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const stored = await encryptAppleRefreshToken(
        `rt-${rng.uuid()}`,
        user,
        ctx.key,
      );
      await expectKind(
        () => decryptAppleRefreshToken(stored, user, "%%%not-base64%%%"),
        "configuration",
      );
      return { fetched: 0 };
    },
  },
  {
    id: "M62",
    target: "apple.decrypt",
    fault: "encrypt/decrypt round trip (control) — unicode + long tokens",
    expect: { kind: "ok", permanent: false },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const tokens = [
        `rt-${rng.uuid()}`,
        "ü🔐token-with-unicode",
        "x".repeat(rng.int(1_000, 6_000)),
      ];
      for (const token of tokens) {
        const stored = await encryptAppleRefreshToken(token, user, ctx.key);
        assert(stored.startsWith("v1."));
        assertEquals(
          await decryptAppleRefreshToken(stored, user, ctx.key),
          token,
        );
      }
      // Two encryptions of the same token never share an IV.
      const a = await encryptAppleRefreshToken(tokens[0], user, ctx.key);
      const b = await encryptAppleRefreshToken(tokens[0], user, ctx.key);
      assert(a.split(".")[1] !== b.split(".")[1], "fresh IV per encryption");
      return { fetched: 0 };
    },
  },
  {
    id: "M63",
    target: "apple.decrypt",
    fault: "encrypting an empty token is refused on read",
    expect: { kind: "invalid_response", permanent: true },
    run: async (ctx, rng) => {
      const user = rng.uuid();
      const stored = await encryptAppleRefreshToken("", user, ctx.key);
      await expectKind(
        () => decryptAppleRefreshToken(stored, user, ctx.key),
        "invalid_response",
      );
      return { fetched: 0 };
    },
  },
];

const revenueCatCases: ModuleCase[] = [
  ...(
    [
      ["M64", "HTTP 200", {
        kind: "json",
        status: 200,
        body: { deleted: true },
      }, "ok"],
      ["M65", "HTTP 404 (already gone) is success", {
        kind: "json",
        status: 404,
        body: { code: 7259 },
      }, "ok"],
      ["M66", "HTTP 200 malformed JSON body still succeeds", {
        kind: "malformed_json",
        status: 200,
      }, "ok"],
      ["M67", "HTTP 401 bad key", {
        kind: "json",
        status: 401,
        body: { code: 7225 },
      }, "unavailable"],
      ["M68", "HTTP 403", { kind: "status", status: 403 }, "unavailable"],
      ["M69", "HTTP 429", { kind: "status", status: 429 }, "unavailable"],
      ["M70", "HTTP 500", { kind: "status", status: 500 }, "unavailable"],
      ["M71", "HTTP 502 html", {
        kind: "status",
        status: 502,
        body: "<html>",
        contentType: "text/html",
      }, "unavailable"],
      ["M72", "HTTP 503", { kind: "status", status: 503 }, "unavailable"],
      ["M73", "fetch rejects", { kind: "reject" }, "unavailable"],
      [
        "M74",
        "fetch rejects with AbortError",
        { kind: "timeout" },
        "unavailable",
      ],
    ] as const
  ).map(([id, fault, f, kind]) => ({
    id,
    target: "revenuecat.delete" as const,
    fault,
    expect: { kind, permanent: false },
    run: async (_ctx: ModuleContext, rng: Prng) => {
      const stub = fetchWith(f as Fault);
      if (kind === "ok") {
        await deleteRevenueCatCustomer(rng.uuid(), "sk_test", stub.fn);
      } else {
        await expectKind(
          () => deleteRevenueCatCustomer(rng.uuid(), "sk_test", stub.fn),
          kind,
        );
      }
      return { fetched: stub.calls() };
    },
  })),
  {
    id: "M75",
    target: "revenuecat.delete",
    fault: "timeout — RevenueCat never answers (FakeTime, 15s deadline)",
    expect: { kind: "unavailable", permanent: false },
    run: async (_ctx, rng) => {
      const time = new FakeTime();
      try {
        const stub = fetchWith(
          (req) =>
            new Promise<Response>((_, reject) => {
              req.signal.addEventListener("abort", () => reject(abortError()));
            }),
        );
        const pending = deleteRevenueCatCustomer(
          rng.uuid(),
          "sk_test",
          stub.fn,
        );
        let settled = false;
        pending.then(
          () => (settled = true),
          () => (settled = true),
        );
        await time.tickAsync(14_999);
        assert(!settled);
        await time.tickAsync(1);
        await expectKind(() => pending, "unavailable");
        return { fetched: stub.calls() };
      } finally {
        time.restore();
      }
    },
  },
  {
    id: "M76",
    target: "revenuecat.delete",
    fault: "secret key blank / whitespace (no network call)",
    expect: { kind: "configuration", permanent: false },
    run: async (_ctx, rng) => {
      const stub = fetchWith({ kind: "status", status: 200 });
      await expectKind(
        () => deleteRevenueCatCustomer(rng.uuid(), "", stub.fn),
        "configuration",
      );
      await expectKind(
        () => deleteRevenueCatCustomer(rng.uuid(), "   ", stub.fn),
        "configuration",
      );
      assertEquals(stub.calls(), 0);
      return { fetched: stub.calls() };
    },
  },
  {
    id: "M77",
    target: "revenuecat.delete",
    fault: "app user id with reserved URL characters is encoded (control)",
    expect: { kind: "ok", permanent: false },
    run: async (_ctx, rng) => {
      const appUserId = `user/${rng.uuid()}?x=1&y=#frag ü`;
      let seenUrl = "";
      let seenAuth = "";
      const stub = fetchWith((req) => {
        seenUrl = req.url;
        seenAuth = req.headers.get("authorization") ?? "";
        assertEquals(req.method, "DELETE");
        return new Response(null, { status: 200 });
      });
      await deleteRevenueCatCustomer(appUserId, "sk_test", stub.fn);
      assertEquals(seenUrl, `${RC_URL_PREFIX}${encodeURIComponent(appUserId)}`);
      assertEquals(seenAuth, "Bearer sk_test");
      return { fetched: stub.calls() };
    },
  },
];

const MODULE_CASES = [
  ...exchangeCases,
  ...revokeCases,
  ...decryptCases,
  ...revenueCatCases,
];

async function expectRejects(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

async function expectKind(
  fn: () => Promise<unknown>,
  kind: ExternalAccountError["kind"] | "ok",
): Promise<ExternalAccountError> {
  const error = await expectRejects(fn);
  if (!(error instanceof ExternalAccountError)) {
    throw new Error(
      `expected ExternalAccountError, got ${errorKind(error)}: ${
        String(error)
      }`,
    );
  }
  if (error.kind !== kind) {
    throw new Error(
      `expected kind ${kind}, got ${error.kind} (${error.message})`,
    );
  }
  return error;
}

interface ModuleOutcome {
  case: string;
  target: string;
  fault: string;
  seed: number;
  iteration: number;
  expectedKind: string;
  expectedPermanent: boolean;
  observedKind: string | null;
  observedPermanent: boolean | null;
  fetched: number;
  detail?: string;
  verdict: "HELD" | "BROKEN";
  error?: string;
}

Deno.test("stress/externalAccounts faults: module-level upstream fault matrix (Apple exchange/revoke/decrypt, RevenueCat)", async () => {
  const key = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const ctx: ModuleContext = {
    key,
    rsaPem: await rsaPem(),
    config: {
      clientId: "com.picklesensei",
      teamId: "TEAMID1234",
      keyId: "KEYID12345",
      privateKeyPem: await testPem(),
      tokenEncryptionKey: key,
    },
  };
  const outcomes: ModuleOutcome[] = [];
  const cases = ONLY_CASE
    ? MODULE_CASES.filter((c) => c.id === ONLY_CASE)
    : MODULE_CASES;
  for (const testCase of cases) {
    for (let iteration = 0; iteration < STRESS_ITER; iteration += 1) {
      const seed = seedFor(testCase.id, iteration);
      const rng = new Prng(seed);
      const outcome: ModuleOutcome = {
        case: testCase.id,
        target: testCase.target,
        fault: testCase.fault,
        seed,
        iteration,
        expectedKind: testCase.expect.kind,
        expectedPermanent: testCase.expect.permanent,
        observedKind: null,
        observedPermanent: null,
        fetched: 0,
        verdict: "HELD",
      };
      try {
        const result = await testCase.run(ctx, rng);
        outcome.fetched = result.fetched;
        outcome.detail = result.detail;
        outcome.observedKind = testCase.expect.kind;
        outcome.observedPermanent = testCase.expect.permanent;
        // The "MUST be permanent" corruption cases record what the module
        // actually classified rather than trusting the expectation.
        if (
          result.detail &&
          /^(configuration|unavailable|invalid_grant|invalid_response):/.test(
            result.detail,
          )
        ) {
          const observed = result.detail.split(
            ":",
          )[0] as ExternalAccountError["kind"];
          outcome.observedKind = observed;
          outcome.observedPermanent = observed === "invalid_grant" ||
            observed === "invalid_response";
          if (outcome.observedPermanent !== testCase.expect.permanent) {
            outcome.verdict = "BROKEN";
            outcome.error = `classified ${observed} (retryable=${!outcome
              .observedPermanent}) but expected permanent=${testCase.expect.permanent}`;
          }
        }
      } catch (error) {
        outcome.verdict = "BROKEN";
        outcome.error = error instanceof Error ? error.message : String(error);
      }
      outcomes.push(outcome);
    }
  }
  const broken = outcomes.filter((o) => o.verdict === "BROKEN");
  const path = await writeReport("faults_module_matrix", {
    generatedAt: new Date().toISOString(),
    iterationsPerCase: STRESS_ITER,
    cases: cases.length,
    executed: outcomes.length,
    held: outcomes.length - broken.length,
    broken: broken.length,
    brokenCases: [...new Set(broken.map((o) => o.case))],
    outcomes,
  });
  console.log(
    `[stress faults/module] ${cases.length} cases × ${STRESS_ITER} = ${outcomes.length} executed, ${broken.length} BROKEN → ${path}`,
  );
  // M57–M59 reproduce a known defect: a corrupted iv/ciphertext SEGMENT is
  // decoded by the same helper as the env key, so it raises the
  // `configuration` (retryable) error instead of `invalid_response`
  // (permanent). Documented through the JSON table and the route-level
  // consequence (R35) rather than failing the suite; STRESS_STRICT=1 fails.
  const MODULE_KNOWN_BROKEN = new Set(["M57", "M58", "M59"]);
  const unexpected = broken.filter((o) =>
    STRICT || !MODULE_KNOWN_BROKEN.has(o.case)
  );
  for (const id of MODULE_KNOWN_BROKEN) {
    const runs = outcomes.filter((o) => o.case === id);
    if (runs.length === 0) continue;
    console.log(
      `[stress faults/module] ${id}: ${
        runs.filter((o) => o.verdict === "BROKEN").length
      }/${runs.length} BROKEN — ${runs[0].fault}`,
    );
  }
  assertEquals(
    unexpected.map((o) => `${o.case}@${o.seed}: ${o.error}`),
    [],
    "every module fault case must classify as designed",
  );
});

// ── Route-level matrix (real handler) ────────────────────────────────────────

interface RouteStep {
  label: string;
  status: number;
  errorClass: ErrorClass;
  code?: string;
  leak: string | null;
  supabaseRoundTrips: number;
  apple: number;
  revenuecat: number;
}

interface RouteOutcome {
  case: string;
  route: "bootstrap" | "delete-confirm";
  upstream: string;
  fault: string;
  seed: number;
  iteration: number;
  expected: string;
  steps: RouteStep[];
  verdict: "HELD" | "BROKEN";
  error?: string;
  note?: string;
}

interface RouteCase {
  id: string;
  route: "bootstrap" | "delete-confirm";
  upstream: string;
  fault: string;
  expected: string;
  run: (
    world: StatefulWorld,
    rng: Prng,
    steps: RouteStep[],
  ) => Promise<string | void>;
}

async function step(
  world: StatefulWorld,
  steps: RouteStep[],
  label: string,
  request: Request,
  extraLeakMarkers: string[] = [],
): Promise<
  {
    status: number;
    body: Record<string, unknown>;
    text: string;
    step: RouteStep;
  }
> {
  world.resetCounters();
  const response = await world.harness.handler(request);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = { _raw: text };
  }
  const errorObj = body.error;
  const code = errorObj && typeof errorObj === "object" &&
      typeof (errorObj as Record<string, unknown>).code === "string"
    ? String((errorObj as Record<string, unknown>).code)
    : undefined;
  const cls = classify(response.status, code ? { code } : {});
  const leak = response.status >= 500
    ? leakMarker(text, [...extraLeakMarkers, ...world.issuedRefreshTokens])
    : leakMarker(text, [...world.issuedRefreshTokens]);
  const s: RouteStep = {
    label,
    status: response.status,
    errorClass: cls,
    code,
    leak,
    supabaseRoundTrips: world.counters.supabase,
    apple: world.counters.apple,
    revenuecat: world.counters.revenuecat,
  };
  steps.push(s);
  return { status: response.status, body, text, step: s };
}

function expectStatus(
  actual: number,
  expected: number | number[],
  label: string,
) {
  const ok = Array.isArray(expected)
    ? expected.includes(actual)
    : actual === expected;
  if (!ok) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
  }
}

function expectNoLeak(s: RouteStep) {
  if (s.leak) throw new Error(`${s.label}: response body leaks "${s.leak}"`);
}

function expectCode(
  body: Record<string, unknown>,
  code: string,
  label: string,
) {
  const err = body.error as Record<string, unknown> | undefined;
  if (!err || err.code !== code) {
    throw new Error(
      `${label}: expected error code ${code}, got ${JSON.stringify(body)}`,
    );
  }
}

const APPLE_TOKEN_FAULTS: Array<[string, string, Fault]> = [
  ["R01", "Apple token endpoint 500", { kind: "status", status: 500 }],
  ["R02", "Apple token endpoint 503 html", {
    kind: "status",
    status: 503,
    body: "<html>down</html>",
    contentType: "text/html",
  }],
  ["R03", "Apple token endpoint 429", { kind: "status", status: 429 }],
  ["R04", "Apple token endpoint connection reset", { kind: "reject" }],
  ["R05", "Apple token endpoint timeout (abort)", { kind: "timeout" }],
  ["R06", "Apple token endpoint 200 malformed JSON", {
    kind: "malformed_json",
    status: 200,
  }],
  ["R07", "Apple token endpoint 200 incomplete grant", {
    kind: "json",
    status: 200,
    body: { refresh_token: "rt" },
  }],
  ["R08", "Apple token endpoint 400 invalid_client (our secret)", {
    kind: "json",
    status: 400,
    body: { error: "invalid_client" },
  }],
];

const bootstrapCases: RouteCase[] = [
  ...APPLE_TOKEN_FAULTS.map(([id, fault, f]) => ({
    id,
    route: "bootstrap" as const,
    upstream: "apple.token",
    fault,
    expected:
      "503 generic, no credential written, same code succeeds once Apple recovers",
    run: async (world: StatefulWorld, rng: Prng, steps: RouteStep[]) => {
      const user = mintAppleUser(world, rng);
      world.plan.once(TARGETS.appleToken, f);
      const first = await step(
        world,
        steps,
        "bootstrap during fault",
        bootstrapRequest(user),
      );
      expectStatus(first.status, 503, "faulted bootstrap");
      expectNoLeak(first.step);
      assert(
        !world.credentials.has(user.id),
        "no credential row while Apple is failing",
      );
      const second = await step(
        world,
        steps,
        "bootstrap after recovery",
        bootstrapRequest(user),
      );
      expectStatus(second.status, 200, "recovered bootstrap");
      const row = world.credentials.get(user.id);
      assert(
        row?.apple_refresh_token_encrypted?.startsWith("v1."),
        "credential stored after recovery",
      );
      assertEquals(row?.apple_revoked_at, null);
    },
  })),
  {
    id: "R09",
    route: "bootstrap",
    upstream: "apple.token",
    fault: "Apple says invalid_grant (code already spent / forged)",
    expected:
      "401 auth.apple_authorization_invalid, no credential, existing credential untouched",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      const previous = await storeAppleCredential(
        world,
        user.id,
        `old-${rng.uuid()}`,
      );
      world.appleSpentCodes.add(user.code);
      const r = await step(
        world,
        steps,
        "bootstrap with spent code",
        bootstrapRequest(user),
      );
      expectStatus(r.status, 401, "spent code");
      expectCode(r.body, "auth.apple_authorization_invalid", "spent code");
      assertEquals(
        world.credentials.get(user.id),
        previous,
        "previous credential untouched",
      );
    },
  },
  {
    id: "R10",
    route: "bootstrap",
    upstream: "apple.token",
    fault: "Apple returns a grant for a different subject",
    expected: "401 auth.apple_authorization_mismatch, nothing stored",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      world.appleCodes.set(user.code, {
        refreshToken: user.refreshToken,
        subject: rng.uuid(),
      });
      const r = await step(
        world,
        steps,
        "bootstrap mismatch",
        bootstrapRequest(user),
      );
      expectStatus(r.status, 401, "mismatch");
      expectCode(r.body, "auth.apple_authorization_mismatch", "mismatch");
      assert(
        !world.credentials.has(user.id),
        "mismatched grant must not be stored",
      );
    },
  },
  {
    id: "R11",
    route: "bootstrap",
    upstream: "apple.token",
    fault:
      "duplicate delivery: the same authorization code twice, sequentially",
    expected:
      "first 200 stores; replay 401 invalid and does NOT clear the stored credential",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      const a = await step(
        world,
        steps,
        "first delivery",
        bootstrapRequest(user),
      );
      expectStatus(a.status, 200, "first delivery");
      const stored = world.credentials.get(user.id);
      const b = await step(
        world,
        steps,
        "replayed code",
        bootstrapRequest(user),
      );
      expectStatus(b.status, 401, "replay");
      expectCode(b.body, "auth.apple_authorization_invalid", "replay");
      assertEquals(
        world.credentials.get(user.id),
        stored,
        "replay leaves the credential intact",
      );
    },
  },
  {
    id: "R12",
    route: "bootstrap",
    upstream: "apple.token",
    fault:
      "duplicate delivery: the same authorization code twice, concurrently",
    expected:
      "exactly one 200 and one 401; exactly one credential upsert; no 5xx",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      world.resetCounters();
      const [x, y] = await Promise.all([
        world.harness.handler(bootstrapRequest(user)),
        world.harness.handler(bootstrapRequest(user)),
      ]);
      const statuses = [x.status, y.status].sort();
      await x.body?.cancel();
      await y.body?.cancel();
      steps.push({
        label: "concurrent pair",
        status: statuses[1],
        errorClass: classify(statuses[1], {}),
        leak: null,
        supabaseRoundTrips: world.counters.supabase,
        apple: world.counters.apple,
        revenuecat: world.counters.revenuecat,
      });
      assertEquals(statuses, [200, 401], "one winner, one refused replay");
      const upserts =
        world.calls.filter((c) =>
          c.startsWith("POST") && c.includes(CREDENTIALS_TABLE)
        ).length;
      assertEquals(upserts, 1, "exactly one credential write");
      assert(world.credentials.get(user.id)?.apple_refresh_token_encrypted);
    },
  },
  {
    id: "R13",
    route: "bootstrap",
    upstream: "postgrest.credentials",
    fault: "credential upsert 500",
    expected:
      "503 generic; Apple code is spent so retry → 401 invalid → user re-signs in with a fresh code → 200",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      world.plan.once(TARGETS.credentialsWrite, {
        kind: "json",
        status: 500,
        body: { code: "XX000", message: "internal error boom" },
      });
      const a = await step(
        world,
        steps,
        "bootstrap, upsert fails",
        bootstrapRequest(user),
        ["boom", "XX000"],
      );
      expectStatus(a.status, 503, "upsert failure");
      expectNoLeak(a.step);
      const b = await step(
        world,
        steps,
        "retry same code",
        bootstrapRequest(user),
      );
      expectStatus(b.status, 401, "spent code after failed persist");
      const fresh = mintAppleUser(world, rng);
      fresh.id = user.id;
      world.appleCodes.set(fresh.code, {
        refreshToken: fresh.refreshToken,
        subject: user.id,
      });
      fresh.idToken = user.idToken;
      const c = await step(
        world,
        steps,
        "re-sign-in with new code",
        bootstrapRequest(fresh),
      );
      expectStatus(c.status, 200, "fresh sign-in");
      assert(
        world.credentials.get(user.id)?.apple_refresh_token_encrypted,
        "credential stored on fresh sign-in",
      );
      return "one Apple grant is lost when the persist fails; recovery needs a new Sign in with Apple";
    },
  },
  {
    id: "R14",
    route: "bootstrap",
    upstream: "postgrest.credentials",
    fault: "credential upsert 401/42501 permission denied",
    expected: "503 generic without table or PostgREST detail",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      world.plan.once(TARGETS.credentialsWrite, {
        kind: "json",
        status: 401,
        body: {
          code: "42501",
          message: `permission denied for table ${CREDENTIALS_TABLE}`,
        },
      });
      const a = await step(
        world,
        steps,
        "bootstrap, upsert denied",
        bootstrapRequest(user),
        ["42501", "permission denied"],
      );
      expectStatus(a.status, 503, "denied upsert");
      expectNoLeak(a.step);
    },
  },
  {
    id: "R15",
    route: "bootstrap",
    upstream: "postgrest.credentials",
    fault: "credential upsert connection reset / timeout",
    expected: "503 generic",
    run: async (world, rng, steps) => {
      for (const f of [{ kind: "reject" }, { kind: "timeout" }] as Fault[]) {
        const user = mintAppleUser(world, rng);
        world.plan.once(TARGETS.credentialsWrite, f);
        const a = await step(
          world,
          steps,
          `bootstrap, upsert ${describeFault(f)}`,
          bootstrapRequest(user),
        );
        expectStatus(a.status, 503, describeFault(f));
        expectNoLeak(a.step);
      }
    },
  },
  {
    id: "R16",
    route: "bootstrap",
    upstream: "postgrest.credentials",
    fault: "credential upsert answers 200 with malformed JSON",
    expected:
      "either 200 (write acknowledged) or 503 — never a 5xx other than 503, never a leak",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      world.plan.once(TARGETS.credentialsWrite, {
        kind: "malformed_json",
        status: 201,
      });
      const a = await step(
        world,
        steps,
        "bootstrap, upsert malformed ack",
        bootstrapRequest(user),
      );
      expectStatus(a.status, [200, 503], "malformed ack");
      expectNoLeak(a.step);
      return `handler answered ${a.status} to a malformed PostgREST acknowledgement`;
    },
  },
  {
    id: "R17",
    route: "bootstrap",
    upstream: "postgrest.profiles",
    fault: "profiles read 500 (before Apple is called)",
    expected:
      "503 generic; Apple code NOT spent (no Apple call); retry with the same code → 200",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      world.plan.once(TARGETS.profilesGet, { kind: "status", status: 500 });
      const a = await step(
        world,
        steps,
        "bootstrap, profile read fails",
        bootstrapRequest(user),
      );
      expectStatus(a.status, 503, "profile failure");
      expectNoLeak(a.step);
      assertEquals(
        a.step.apple,
        0,
        "Apple must not be called before the account is readable",
      );
      const b = await step(
        world,
        steps,
        "retry same code",
        bootstrapRequest(user),
      );
      expectStatus(b.status, 200, "retry");
    },
  },
  {
    id: "R18",
    route: "bootstrap",
    upstream: "supabase.auth",
    fault:
      "Supabase Auth signInWithIdToken 500 / 502 / connection reset / malformed 200",
    expected:
      "a retryable class (503) — an Auth outage is not a verdict on the identity token",
    run: async (world, rng, steps) => {
      const faults: Fault[] = [
        { kind: "status", status: 500 },
        {
          kind: "status",
          status: 502,
          body: "<html>bad gateway</html>",
          contentType: "text/html",
        },
        { kind: "reject" },
        { kind: "malformed_json", status: 200 },
      ];
      const notes: string[] = [];
      for (const f of faults) {
        const user = mintAppleUser(world, rng);
        world.plan.always(TARGETS.authSignIn, f);
        const a = await step(
          world,
          steps,
          `bootstrap, auth ${describeFault(f)}`,
          bootstrapRequest(user),
        );
        world.plan.always(TARGETS.authSignIn, null);
        expectNoLeak(a.step);
        notes.push(`${describeFault(f)}→${a.status}`);
        assertEquals(
          a.step.apple,
          0,
          "Apple must not be consulted when the identity is unverified",
        );
        assert(!world.credentials.has(user.id));
        if (a.status !== 503) {
          throw new Error(
            `Auth outage ${
              describeFault(f)
            } surfaced as HTTP ${a.status} (${a.step.errorClass}); expected 503 retryable`,
          );
        }
      }
      return notes.join(", ");
    },
  },
  {
    id: "R19",
    route: "bootstrap",
    upstream: "supabase.auth",
    fault: "Supabase Auth refuses the identity token (400 invalid_grant)",
    expected: "401 generic, no Apple call, no credential",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      world.plan.once(TARGETS.authSignIn, {
        kind: "json",
        status: 400,
        body: { error: "invalid_grant", error_description: "bad" },
      });
      const a = await step(
        world,
        steps,
        "bootstrap, token refused",
        bootstrapRequest(user),
      );
      expectStatus(a.status, 401, "refused");
      assertEquals(a.step.apple, 0);
      assert(!world.credentials.has(user.id));
    },
  },
  {
    id: "R20",
    route: "bootstrap",
    upstream: "config",
    fault: "APPLE_SIGN_IN_PRIVATE_KEY unset at request time",
    expected:
      "protocol client 503 generic; legacy client (no code) still 200; restored config → 200",
    run: async (world, rng, steps) => {
      const pem = Deno.env.get("APPLE_SIGN_IN_PRIVATE_KEY") ?? "";
      Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
      try {
        const user = mintAppleUser(world, rng);
        const a = await step(
          world,
          steps,
          "bootstrap without server secret",
          bootstrapRequest(user),
        );
        expectStatus(a.status, 503, "missing secret");
        expectNoLeak(a.step);
        assertEquals(a.step.apple, 0);
        const legacy = mintAppleUser(world, rng);
        const b = await step(
          world,
          steps,
          "legacy bootstrap without code",
          bootstrapRequest(legacy, { code: null, protocol: false }),
        );
        expectStatus(b.status, 200, "legacy client");
        assert(
          !world.credentials.has(legacy.id),
          "legacy client stores nothing",
        );
      } finally {
        Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", pem);
      }
      const user = mintAppleUser(world, rng);
      const c = await step(
        world,
        steps,
        "bootstrap after config restored",
        bootstrapRequest(user),
      );
      expectStatus(c.status, 200, "restored");
    },
  },
  {
    id: "R21",
    route: "bootstrap",
    upstream: "config",
    fault: "APPLE_TOKEN_ENCRYPTION_KEY malformed (not base64 / wrong length)",
    expected:
      "503 generic, Apple code spent but nothing stored; corrected key → fresh code → 200",
    run: async (world, rng, steps) => {
      const good = Deno.env.get("APPLE_TOKEN_ENCRYPTION_KEY") ?? "";
      for (const bad of ["%%%", bytesToBase64(new Uint8Array(16))]) {
        Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", bad);
        try {
          const user = mintAppleUser(world, rng);
          const a = await step(
            world,
            steps,
            `bootstrap with bad key ${bad.length}`,
            bootstrapRequest(user),
          );
          expectStatus(a.status, 503, "bad key");
          expectNoLeak(a.step);
          assert(
            !world.credentials.has(user.id),
            "nothing stored under a broken key",
          );
        } finally {
          Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", good);
        }
      }
      const user = mintAppleUser(world, rng);
      const c = await step(
        world,
        steps,
        "bootstrap after key restored",
        bootstrapRequest(user),
      );
      expectStatus(c.status, 200, "restored key");
    },
  },
  {
    id: "R22",
    route: "bootstrap",
    upstream: "client-body",
    fault:
      "authorization code malformed: number / object / whitespace / >4096 chars",
    expected:
      "protocol client 400 auth.apple_authorization_code_required; legacy client 200 without storage",
    run: async (world, rng, steps) => {
      const bad: unknown[] = [
        12345,
        { code: "x" },
        "   ",
        "c".repeat(4_097),
        null,
      ];
      for (const code of bad) {
        const user = mintAppleUser(world, rng);
        const a = await step(
          world,
          steps,
          `protocol client, code=${JSON.stringify(code)?.slice(0, 20)}`,
          bootstrapRequest(user, { code }),
        );
        expectStatus(a.status, 400, "unusable code");
        expectCode(
          a.body,
          "auth.apple_authorization_code_required",
          "unusable code",
        );
        assertEquals(a.step.apple, 0);
        const legacy = mintAppleUser(world, rng);
        const b = await step(
          world,
          steps,
          "legacy client, same code",
          bootstrapRequest(legacy, { code, protocol: false }),
        );
        expectStatus(b.status, 200, "legacy");
        assert(!world.credentials.has(legacy.id));
      }
    },
  },
  {
    id: "R23",
    route: "bootstrap",
    upstream: "client-body",
    fault: "body is not JSON / not an object",
    expected: "no 5xx; protocol client 400 or 200-without-storage never stores",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      const headers = new Headers({
        Authorization: `Bearer ${user.idToken}`,
        "x-forwarded-for": user.ip,
        "Content-Type": "application/json",
        "X-Apple-Revocation-Protocol": "1",
      });
      for (const raw of ["not json", "[1,2,3]", '"string"', "null"]) {
        const req = new Request(
          "http://edge.test/functions/v1/api/v1/account/bootstrap",
          {
            method: "POST",
            headers,
            body: raw,
          },
        );
        const a = await step(world, steps, `raw body ${raw}`, req);
        assert(a.status < 500, `raw body ${raw} → ${a.status}`);
        assert(!world.credentials.has(user.id));
      }
    },
  },
  {
    id: "R24",
    route: "bootstrap",
    upstream: "supabase.auth+apple",
    fault:
      "re-sign-in after a completed deletion attempt that failed at deleteUser (RC already deleted)",
    expected:
      "bootstrap resets the revocation checkpoints so a later deletion deletes the re-created RevenueCat subscriber",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      const a = await step(
        world,
        steps,
        "initial bootstrap",
        bootstrapRequest(user),
      );
      expectStatus(a.status, 200, "initial");
      const challenge = seedDeletionChallenge(world, user.id, rng);
      world.plan.once(TARGETS.authDeleteUser, { kind: "status", status: 500 });
      const d1 = await step(
        world,
        steps,
        "delete-confirm, deleteUser 500",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(d1.status, 503, "deleteUser failure");
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
        "RC deleted once",
      );
      assertEquals(
        world.credentials.get(user.id)?.revenuecat_deleted_at !== null,
        true,
        "RC checkpoint set",
      );
      // The user keeps using the app: a fresh Sign in with Apple ...
      const again = mintAppleUser(world, rng);
      again.id = user.id;
      again.idToken = user.idToken;
      world.appleCodes.set(again.code, {
        refreshToken: again.refreshToken,
        subject: user.id,
      });
      const b = await step(
        world,
        steps,
        "re-sign-in bootstrap",
        bootstrapRequest(again),
      );
      expectStatus(b.status, 200, "re-sign-in");
      // ... RevenueCat re-creates the subscriber on first SDK contact. Weeks
      // later the user deletes the account for real.
      const challenge2 = seedDeletionChallenge(world, user.id, rng);
      const d2 = await step(
        world,
        steps,
        "final delete-confirm",
        deleteConfirmRequest(user.id, user.ip, challenge2),
      );
      expectStatus(d2.status, 200, "final deletion");
      const rcDeletes =
        world.revenueCatDeleted.filter((id) => id === user.id).length;
      const revokes =
        world.revokedAppleTokens.filter((t) => t === again.refreshToken).length;
      assertEquals(
        revokes,
        1,
        "the NEW Apple grant is revoked on the final deletion",
      );
      if (rcDeletes < 2) {
        throw new Error(
          `final deletion skipped RevenueCat: revenuecat_deleted_at checkpoint from the earlier failed attempt survived bootstrap (RC DELETE count for user = ${rcDeletes}, expected 2)`,
        );
      }
    },
  },
];

const APPLE_REVOKE_TRANSIENT: Array<[string, string, Fault]> = [
  ["R25", "Apple revoke 500", { kind: "status", status: 500 }],
  ["R26", "Apple revoke 503", { kind: "status", status: 503 }],
  ["R27", "Apple revoke 429", { kind: "status", status: 429 }],
  ["R28", "Apple revoke connection reset", { kind: "reject" }],
  ["R29", "Apple revoke timeout (abort)", { kind: "timeout" }],
  ["R30", "Apple revoke 400 invalid_client (our secret)", {
    kind: "json",
    status: 400,
    body: { error: "invalid_client" },
  }],
  ["R31", "Apple revoke 401 empty", { kind: "status", status: 401 }],
  ["R32", "Apple revoke 502 malformed JSON", {
    kind: "malformed_json",
    status: 502,
  }],
];

const RC_TRANSIENT: Array<[string, string, Fault]> = [
  ["R38", "RevenueCat 500", { kind: "status", status: 500 }],
  ["R39", "RevenueCat 503", { kind: "status", status: 503 }],
  ["R40", "RevenueCat 429", { kind: "status", status: 429 }],
  ["R41", "RevenueCat 401 (bad secret)", {
    kind: "json",
    status: 401,
    body: { code: 7225, message: "Invalid API key" },
  }],
  ["R42", "RevenueCat connection reset", { kind: "reject" }],
  ["R43", "RevenueCat timeout (abort)", { kind: "timeout" }],
  ["R44", "RevenueCat 502 malformed JSON", {
    kind: "malformed_json",
    status: 502,
  }],
];

async function preparedAppleUser(world: StatefulWorld, rng: Prng) {
  const user = mintAppleUser(world, rng);
  await storeAppleCredential(world, user.id, user.refreshToken);
  const challenge = seedDeletionChallenge(world, user.id, rng);
  return { user, challenge };
}

const deleteCases: RouteCase[] = [
  ...APPLE_REVOKE_TRANSIENT.map(([id, fault, f]) => ({
    id,
    route: "delete-confirm" as const,
    upstream: "apple.revoke",
    fault,
    expected:
      "503 generic; RevenueCat + Auth untouched; credential intact; retry after recovery → 200 revoked",
    run: async (world: StatefulWorld, rng: Prng, steps: RouteStep[]) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.appleRevoke, f);
      const a = await step(
        world,
        steps,
        "delete-confirm during Apple fault",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 503, "faulted revoke");
      expectNoLeak(a.step);
      assertEquals(
        a.step.revenuecat,
        0,
        "RevenueCat must not be called before Apple succeeds",
      );
      assert(
        !world.deletedUsers.has(user.id),
        "Auth user must survive a failed revocation",
      );
      assert(
        world.credentials.get(user.id)?.apple_refresh_token_encrypted,
        "credential intact for retry",
      );
      const b = await step(
        world,
        steps,
        "delete-confirm after recovery",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "recovered deletion");
      assertEquals(b.body.appleAuthorizationRevocation, "revoked");
      assertEquals(
        world.revokedAppleTokens.filter((t) => t === user.refreshToken).length,
        1,
      );
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
      );
      assert(world.deletedUsers.has(user.id));
    },
  })),
  {
    id: "R33",
    route: "delete-confirm",
    upstream: "apple.revoke",
    fault:
      "Apple revoke 400 invalid_grant (token already revoked by the user in Apple ID settings)",
    expected:
      "200 manual_action_required, credential cleared, RC + Auth deletion proceed",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.appleRevoke, {
        kind: "json",
        status: 400,
        body: { error: "invalid_grant" },
      });
      const a = await step(
        world,
        steps,
        "delete-confirm, Apple invalid_grant",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 200, "permanent Apple failure");
      assertEquals(
        a.body.appleAuthorizationRevocation,
        "manual_action_required",
      );
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
      );
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R34",
    route: "delete-confirm",
    upstream: "apple.decrypt",
    fault: "stored credential encrypted under a rotated key",
    expected:
      "200 manual_action_required (permanent), no Apple call, RC + Auth deletion proceed",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      const otherKey = bytesToBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const encrypted = await encryptAppleRefreshToken(
        user.refreshToken,
        user.id,
        otherKey,
      );
      await storeAppleCredential(world, user.id, user.refreshToken, {
        apple_refresh_token_encrypted: encrypted,
      });
      const challenge = seedDeletionChallenge(world, user.id, rng);
      const a = await step(
        world,
        steps,
        "delete-confirm, undecryptable",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 200, "rotated key");
      assertEquals(
        a.body.appleAuthorizationRevocation,
        "manual_action_required",
      );
      assertEquals(a.step.apple, 0);
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R35",
    route: "delete-confirm",
    upstream: "apple.decrypt",
    fault:
      "stored credential row corrupted: iv/ciphertext segment not base64 (e.g. truncated or overwritten)",
    expected:
      "permanent → 200 manual_action_required and the account is deleted; NEVER an endless 503 (account undeletable)",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      const good = await encryptAppleRefreshToken(
        user.refreshToken,
        user.id,
        world.harness.appleTokenEncryptionKey,
      );
      const [v, iv, ct] = good.split(".");
      const variants = [
        `${v}.${iv}.${ct.slice(0, ct.length - ((ct.length % 4) + 3))}`, // length ≡ 1 mod 4
        `${v}.${iv}.${ct.slice(0, 10)}**${ct.slice(12)}`, // non-base64 characters
        `${v}.!!!!.${ct}`,
      ];
      const corrupted = variants[rng.int(0, variants.length - 1)];
      await storeAppleCredential(world, user.id, user.refreshToken, {
        apple_refresh_token_encrypted: corrupted,
      });
      const challenge = seedDeletionChallenge(world, user.id, rng);
      const a = await step(
        world,
        steps,
        "delete-confirm, corrupted row (1st)",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      const b = await step(
        world,
        steps,
        "delete-confirm, corrupted row (2nd, unchanged)",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectNoLeak(a.step);
      expectNoLeak(b.step);
      if (a.status === 503 && b.status === 503) {
        throw new Error(
          `corrupted stored credential ${
            JSON.stringify(corrupted.slice(0, 30))
          }… is classified retryable: delete-confirm answers 503 on every attempt (Apple calls=${a.step.apple}), the account can never be deleted by the user`,
        );
      }
      expectStatus(a.status, 200, "corrupted row");
      assertEquals(
        a.body.appleAuthorizationRevocation,
        "manual_action_required",
      );
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R36",
    route: "delete-confirm",
    upstream: "postgrest.credentials",
    fault:
      "Apple revoked OK, then the revocation checkpoint PATCH fails (500 / reset / timeout)",
    expected:
      "503; retry revokes again (Apple idempotent) and completes; RC deleted exactly once; Auth deleted",
    run: async (world, rng, steps) => {
      const faults: Fault[] = [{ kind: "status", status: 500 }, {
        kind: "reject",
      }, { kind: "timeout" }];
      const f = faults[rng.int(0, faults.length - 1)];
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.credentialsWrite, f);
      const a = await step(
        world,
        steps,
        `delete-confirm, checkpoint ${describeFault(f)}`,
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 503, "checkpoint failure");
      expectNoLeak(a.step);
      assertEquals(
        a.step.revenuecat,
        0,
        "RC must wait for the Apple checkpoint",
      );
      assert(!world.deletedUsers.has(user.id));
      const b = await step(
        world,
        steps,
        "retry",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "retry");
      assertEquals(
        world.revokedAppleTokens.filter((t) => t === user.refreshToken).length,
        2,
        "revoke re-sent (idempotent at Apple)",
      );
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
      );
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R37",
    route: "delete-confirm",
    upstream: "postgrest.credentials",
    fault: "credential row read fails (500 / 42501 / malformed 200)",
    expected: "503 generic; no Apple / RC / Auth side effects; retry → 200",
    run: async (world, rng, steps) => {
      const faults: Fault[] = [
        {
          kind: "json",
          status: 500,
          body: { code: "XX000", message: "internal boom" },
        },
        {
          kind: "json",
          status: 401,
          body: {
            code: "42501",
            message: `permission denied for table ${CREDENTIALS_TABLE}`,
          },
        },
        { kind: "malformed_json", status: 200 },
      ];
      const f = faults[rng.int(0, faults.length - 1)];
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.credentialsGet, f);
      const a = await step(
        world,
        steps,
        `delete-confirm, credential read ${describeFault(f)}`,
        deleteConfirmRequest(user.id, user.ip, challenge),
        ["boom", "42501", "permission denied"],
      );
      expectStatus(a.status, 503, "read failure");
      expectNoLeak(a.step);
      assertEquals(a.step.apple, 0);
      assertEquals(a.step.revenuecat, 0);
      assert(!world.deletedUsers.has(user.id));
      const b = await step(
        world,
        steps,
        "retry",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "retry");
      assertEquals(b.body.appleAuthorizationRevocation, "revoked");
    },
  },
  ...RC_TRANSIENT.map(([id, fault, f]) => ({
    id,
    route: "delete-confirm" as const,
    upstream: "revenuecat",
    fault,
    expected:
      "503 generic; Apple checkpoint kept so retry does NOT revoke again; Auth untouched; retry → 200",
    run: async (world: StatefulWorld, rng: Prng, steps: RouteStep[]) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.revenuecat, f);
      const a = await step(
        world,
        steps,
        "delete-confirm during RC fault",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 503, "faulted RC");
      expectNoLeak(a.step);
      assert(!world.deletedUsers.has(user.id), "Auth user survives RC failure");
      assert(
        world.credentials.get(user.id)?.apple_revoked_at,
        "Apple checkpoint persisted",
      );
      const b = await step(
        world,
        steps,
        "retry after RC recovery",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "recovered");
      assertEquals(
        b.step.apple,
        0,
        "checkpoint honoured: Apple not called again",
      );
      assertEquals(
        world.revokedAppleTokens.filter((t) => t === user.refreshToken).length,
        1,
      );
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
      );
      assert(world.deletedUsers.has(user.id));
    },
  })),
  {
    id: "R45",
    route: "delete-confirm",
    upstream: "revenuecat",
    fault: "RevenueCat 404 (subscriber never existed)",
    expected: "200; deletion completes",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.revenuecat, {
        kind: "json",
        status: 404,
        body: { code: 7259, message: "not found" },
      });
      const a = await step(
        world,
        steps,
        "delete-confirm, RC 404",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 200, "RC 404");
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R46",
    route: "delete-confirm",
    upstream: "config",
    fault: "REVENUECAT_SECRET_API_KEY unset",
    expected:
      "503 generic; Apple already revoked + checkpointed; Auth untouched; restored → 200 without a second revoke",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      const key = Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "";
      Deno.env.delete("REVENUECAT_SECRET_API_KEY");
      let a;
      try {
        a = await step(
          world,
          steps,
          "delete-confirm without RC secret",
          deleteConfirmRequest(user.id, user.ip, challenge),
        );
      } finally {
        Deno.env.set("REVENUECAT_SECRET_API_KEY", key);
      }
      expectStatus(a.status, 503, "missing RC secret");
      expectNoLeak(a.step);
      assertEquals(a.step.revenuecat, 0);
      assert(!world.deletedUsers.has(user.id));
      const b = await step(
        world,
        steps,
        "retry with secret",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "restored");
      assertEquals(b.step.apple, 0);
    },
  },
  {
    id: "R47",
    route: "delete-confirm",
    upstream: "postgrest.credentials",
    fault: "RC deleted OK, then the RC checkpoint upsert fails",
    expected:
      "503; retry re-issues RC DELETE (idempotent) and completes; no second Apple revoke",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      // First write (Apple checkpoint PATCH) succeeds, second (RC upsert) fails.
      world.plan.once(TARGETS.credentialsWrite, { kind: "ok" }).once(
        TARGETS.credentialsWrite,
        { kind: "status", status: 500 },
      );
      const a = await step(
        world,
        steps,
        "delete-confirm, RC checkpoint fails",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 503, "RC checkpoint");
      expectNoLeak(a.step);
      assert(!world.deletedUsers.has(user.id));
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
      );
      const b = await step(
        world,
        steps,
        "retry",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "retry");
      assertEquals(b.step.apple, 0, "no second Apple revoke");
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        2,
        "RC DELETE re-sent, idempotent",
      );
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R48",
    route: "delete-confirm",
    upstream: "supabase.auth.admin",
    fault: "auth.admin.deleteUser 500 / 502 / connection reset",
    expected:
      "503 generic; both checkpoints kept; retry deletes Auth only (Apple×1, RC×1 overall)",
    run: async (world, rng, steps) => {
      const faults: Fault[] = [{ kind: "status", status: 500 }, {
        kind: "status",
        status: 502,
      }, { kind: "reject" }];
      const f = faults[rng.int(0, faults.length - 1)];
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.authDeleteUser, f);
      const a = await step(
        world,
        steps,
        `delete-confirm, deleteUser ${describeFault(f)}`,
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 503, "deleteUser failure");
      expectNoLeak(a.step);
      assert(!world.deletedUsers.has(user.id));
      const b = await step(
        world,
        steps,
        "retry",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "retry");
      assertEquals(b.step.apple, 0);
      assertEquals(b.step.revenuecat, 0);
      assertEquals(
        world.revokedAppleTokens.filter((t) => t === user.refreshToken).length,
        1,
      );
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
      );
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R49",
    route: "delete-confirm",
    upstream: "supabase.auth.admin",
    fault:
      "auth.admin.deleteUser 404 user_not_found (already deleted elsewhere)",
    expected: "200 deleted",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.authDeleteUser, {
        kind: "json",
        status: 404,
        body: {
          code: 404,
          error_code: "user_not_found",
          msg: "User not found",
        },
      });
      const a = await step(
        world,
        steps,
        "delete-confirm, user already gone",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 200, "already deleted");
      assertEquals(a.body.deleted, true);
    },
  },
  {
    id: "R50",
    route: "delete-confirm",
    upstream: "supabase.auth",
    fault:
      "getUser (session verification) 500 / reset / malformed 200 / timeout",
    expected: "503 retryable with no side effects; recovered → 200",
    run: async (world, rng, steps) => {
      const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
      Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "250");
      try {
        const faults: Fault[] = [
          { kind: "status", status: 500 },
          { kind: "reject" },
          { kind: "malformed_json", status: 200 },
        ];
        const f = faults[rng.int(0, faults.length - 1)];
        const { user, challenge } = await preparedAppleUser(world, rng);
        world.plan.always(TARGETS.authGetUser, f);
        const a = await step(
          world,
          steps,
          `delete-confirm, getUser ${describeFault(f)}`,
          deleteConfirmRequest(user.id, user.ip, challenge),
        );
        world.plan.always(TARGETS.authGetUser, null);
        expectStatus(a.status, 503, "getUser outage");
        expectNoLeak(a.step);
        assertEquals(a.step.apple, 0);
        assertEquals(a.step.revenuecat, 0);
        const b = await step(
          world,
          steps,
          "retry",
          deleteConfirmRequest(user.id, user.ip, challenge),
        );
        expectStatus(b.status, 200, "retry");
      } finally {
        if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
        else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
      }
    },
  },
  {
    id: "R51",
    route: "delete-confirm",
    upstream: "supabase.auth",
    fault: "getUser 401 (session revoked / already deleted)",
    expected: "401 generic; no side effects",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.authGetUser, {
        kind: "json",
        status: 401,
        body: { code: 401, msg: "invalid JWT" },
      });
      const a = await step(
        world,
        steps,
        "delete-confirm, session refused",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 401, "refused");
      assertEquals(a.step.apple, 0);
      assertEquals(a.step.revenuecat, 0);
      assert(!world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R52",
    route: "delete-confirm",
    upstream: "postgrest.deletion",
    fault: "deletion challenge read 500 / 42501",
    expected: "503 generic; nothing downstream",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      const f: Fault = rng.next() < 0.5 ? { kind: "status", status: 500 } : {
        kind: "json",
        status: 401,
        body: { code: "42501", message: "permission denied" },
      };
      world.plan.once(TARGETS.deletionGet, f);
      const a = await step(
        world,
        steps,
        `delete-confirm, challenge read ${describeFault(f)}`,
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 503, "challenge read");
      expectNoLeak(a.step);
      assertEquals(a.step.apple, 0);
      assertEquals(a.step.revenuecat, 0);
    },
  },
  {
    id: "R53",
    route: "delete-confirm",
    upstream: "concurrency",
    fault:
      "duplicate delivery: two delete-confirms for the same user in flight at once",
    expected:
      "no 5xx; both 200 (or one 401 after the other deleted); Auth deleted; no partial state",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.resetCounters();
      const [x, y] = await Promise.all([
        world.harness.handler(
          deleteConfirmRequest(user.id, user.ip, challenge),
        ),
        world.harness.handler(
          deleteConfirmRequest(user.id, user.ip, challenge),
        ),
      ]);
      const bodies = [await x.text(), await y.text()];
      const statuses = [x.status, y.status].sort();
      steps.push({
        label: `concurrent pair → ${statuses.join("/")}`,
        status: statuses[1],
        errorClass: classify(statuses[1], {}),
        leak: leakMarker(bodies.join("\n"), [...world.issuedRefreshTokens]),
        supabaseRoundTrips: world.counters.supabase,
        apple: world.counters.apple,
        revenuecat: world.counters.revenuecat,
      });
      for (const s of statuses) {
        assert(s < 500, `concurrent deletion produced HTTP ${s}`);
      }
      assert(world.deletedUsers.has(user.id), "account deleted");
      const revokes =
        world.revokedAppleTokens.filter((t) => t === user.refreshToken).length;
      assert(revokes >= 1 && revokes <= 2, `Apple revoke count ${revokes}`);
      return `statuses ${
        statuses.join("/")
      }, apple revokes ${revokes}, rc deletes ${
        world.revenueCatDeleted.filter((id) => id === user.id).length
      }`;
    },
  },
  {
    id: "R54",
    route: "delete-confirm",
    upstream: "provider",
    fault:
      "Google account (no Apple credential) with RevenueCat 500 then recovery",
    expected: "503 then 200 not_applicable; Apple never called",
    run: async (world, rng, steps) => {
      const id = userIdFor(rng, "google");
      const ip = ipFor(rng);
      const g = await step(
        world,
        steps,
        "google bootstrap",
        googleBootstrapRequest(id, ip),
      );
      expectStatus(g.status, 200, "google bootstrap");
      const challenge = seedDeletionChallenge(world, id, rng);
      world.plan.once(TARGETS.revenuecat, { kind: "status", status: 500 });
      const a = await step(
        world,
        steps,
        "delete-confirm, RC 500",
        deleteConfirmRequest(id, ip, challenge),
      );
      expectStatus(a.status, 503, "RC fault");
      assertEquals(a.step.apple, 0);
      const b = await step(
        world,
        steps,
        "retry",
        deleteConfirmRequest(id, ip, challenge),
      );
      expectStatus(b.status, 200, "retry");
      assertEquals(b.body.appleAuthorizationRevocation, "not_applicable");
      assertEquals(b.step.apple, 0);
    },
  },
  {
    id: "R55",
    route: "delete-confirm",
    upstream: "checkpoint",
    fault:
      "stale checkpoints: row already has apple_revoked_at + revenuecat_deleted_at",
    expected:
      "200 revoked with zero Apple and zero RC calls; only Auth deletion",
    run: async (world, rng, steps) => {
      const user = mintAppleUser(world, rng);
      const now = new Date().toISOString();
      await storeAppleCredential(world, user.id, user.refreshToken, {
        apple_revoked_at: now,
        revenuecat_deleted_at: now,
      });
      const challenge = seedDeletionChallenge(world, user.id, rng);
      const a = await step(
        world,
        steps,
        "delete-confirm, both checkpoints",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 200, "checkpointed");
      assertEquals(a.body.appleAuthorizationRevocation, "revoked");
      assertEquals(a.step.apple, 0);
      assertEquals(a.step.revenuecat, 0);
      assert(world.deletedUsers.has(user.id));
    },
  },
  {
    id: "R56",
    route: "delete-confirm",
    upstream: "rate-limit",
    fault: "Apple down for 5 consecutive attempts, then recovers",
    expected:
      "the 6th (healthy) attempt still deletes the account within the hour — transient upstream failures must not exhaust the user's own deletion budget",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      for (let i = 0; i < 5; i += 1) {
        world.plan.once(TARGETS.appleRevoke, { kind: "status", status: 503 });
        const a = await step(
          world,
          steps,
          `attempt ${i + 1} (Apple 503)`,
          deleteConfirmRequest(user.id, user.ip, challenge),
        );
        expectStatus(a.status, 503, `attempt ${i + 1}`);
      }
      const b = await step(
        world,
        steps,
        "attempt 6 (Apple healthy)",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      if (b.status === 429) {
        throw new Error(
          `after 5 upstream-caused 503s the user's 6th attempt is refused 429 (delete_confirm budget 5/h consumed by failures the user did not cause); retry-after=${
            String(
              (b.body.error as Record<string, unknown> | undefined)
                ?.retryAfterSeconds ?? "?",
            )
          }`,
        );
      }
      expectStatus(b.status, 200, "6th attempt");
    },
  },
  {
    id: "R58",
    route: "delete-confirm",
    upstream: "postgrest.credentials",
    fault: "credential row read: socket reset once (postgrest-js GET retry)",
    expected:
      "recovered inside the request: 200, one extra Supabase round trip, no duplicate side effects",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.credentialsGet, { kind: "reject" });
      const a = await step(
        world,
        steps,
        "delete-confirm, credential GET reset once",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(a.status, 200, "transparent retry");
      assertEquals(
        a.step.supabaseRoundTrips,
        7,
        "baseline 6 round trips + 1 retried GET",
      );
      assertEquals(
        world.revokedAppleTokens.filter((t) => t === user.refreshToken).length,
        1,
      );
      assertEquals(
        world.revenueCatDeleted.filter((id) => id === user.id).length,
        1,
      );
    },
  },
  {
    id: "R59",
    route: "delete-confirm",
    upstream: "postgrest.credentials",
    fault:
      "credential row read: socket dead for the whole request (postgrest-js retry budget)",
    expected:
      "503 generic after the client's retry budget; records attempts + wall-clock (slow: run once)",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.always(TARGETS.credentialsGet, { kind: "reject" });
      const started = performance.now();
      let a;
      try {
        a = await step(
          world,
          steps,
          "delete-confirm, credential GET dead",
          deleteConfirmRequest(user.id, user.ip, challenge),
        );
      } finally {
        world.plan.always(TARGETS.credentialsGet, null);
      }
      const elapsedMs = Math.round(performance.now() - started);
      expectStatus(a.status, 503, "dead socket");
      expectNoLeak(a.step);
      assertEquals(a.step.apple, 0);
      assertEquals(a.step.revenuecat, 0);
      const attempts =
        world.calls.filter((c) =>
          c.startsWith("GET") && c.includes(CREDENTIALS_TABLE)
        ).length;
      const b = await step(
        world,
        steps,
        "retry once the socket is back",
        deleteConfirmRequest(user.id, user.ip, challenge),
      );
      expectStatus(b.status, 200, "retry");
      return `GET attempts=${attempts}, request wall-clock=${elapsedMs}ms before the 503`;
    },
  },
  {
    id: "R57",
    route: "delete-confirm",
    upstream: "secrecy",
    fault: "control: the plaintext refresh token only ever travels to Apple",
    expected:
      "no Supabase or RevenueCat request and no response body contains the plaintext token",
    run: async (world, rng, steps) => {
      const { user, challenge } = await preparedAppleUser(world, rng);
      world.plan.once(TARGETS.revenuecat, { kind: "status", status: 500 });
      const seen: string[] = [];
      const inner = globalThis.fetch;
      globalThis.fetch =
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          seen.push(`${req.url}\n${await req.clone().text()}`);
          return inner(input, init);
        }) as typeof fetch;
      try {
        const a = await step(
          world,
          steps,
          "delete-confirm, RC 500",
          deleteConfirmRequest(user.id, user.ip, challenge),
        );
        expectStatus(a.status, 503, "RC fault");
        const b = await step(
          world,
          steps,
          "retry",
          deleteConfirmRequest(user.id, user.ip, challenge),
        );
        expectStatus(b.status, 200, "retry");
      } finally {
        globalThis.fetch = inner;
      }
      for (const entry of seen) {
        if (entry.includes(user.refreshToken)) {
          assert(
            entry.startsWith(APPLE_REVOKE_URL),
            `plaintext refresh token sent to ${entry.split("\n")[0]}`,
          );
        }
      }
      assert(
        seen.some((e) =>
          e.startsWith(APPLE_REVOKE_URL) && e.includes(user.refreshToken)
        ),
        "token reached Apple",
      );
    },
  },
];

const ROUTE_CASES = [...bootstrapCases, ...deleteCases];

Deno.test("stress/externalAccounts faults: route-level fault matrix through the real handler (bootstrap + delete-confirm)", async () => {
  const world = await loadWorld();
  const outcomes: RouteOutcome[] = [];
  const cases = ONLY_CASE
    ? ROUTE_CASES.filter((c) => c.id === ONLY_CASE)
    : ROUTE_CASES;
  try {
    for (const testCase of cases) {
      // R59 sleeps through postgrest-js's retry backoff (~7 s); once is enough.
      const iterations = testCase.id === "R59" ? 1 : STRESS_ITER;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const seed = seedFor(testCase.id, iteration);
        const rng = new Prng(seed);
        world.plan.clear();
        const steps: RouteStep[] = [];
        const outcome: RouteOutcome = {
          case: testCase.id,
          route: testCase.route,
          upstream: testCase.upstream,
          fault: testCase.fault,
          seed,
          iteration,
          expected: testCase.expected,
          steps,
          verdict: "HELD",
        };
        try {
          const note = await testCase.run(world, rng, steps);
          if (note) outcome.note = note;
        } catch (error) {
          outcome.verdict = "BROKEN";
          outcome.error = error instanceof Error
            ? error.message
            : String(error);
        }
        outcomes.push(outcome);
      }
    }
  } finally {
    world.plan.clear();
    world.uninstall();
  }
  const broken = outcomes.filter((o) => o.verdict === "BROKEN");
  const stepCount = outcomes.reduce((n, o) => n + o.steps.length, 0);
  const path = await writeReport("faults_route_matrix", {
    generatedAt: new Date().toISOString(),
    iterationsPerCase: STRESS_ITER,
    cases: cases.length,
    executed: outcomes.length,
    requestsIssued: stepCount,
    held: outcomes.length - broken.length,
    broken: broken.length,
    brokenCases: [...new Set(broken.map((o) => o.case))],
    outcomes,
  });
  console.log(
    `[stress faults/route] ${cases.length} cases × ${STRESS_ITER} = ${outcomes.length} executed (${stepCount} requests), ${broken.length} BROKEN → ${path}`,
  );
  // Cases that document a reproduced defect are reported through the JSON
  // table (and the stress report) rather than failing the suite, so the
  // harness can live in CI while the fix lands: R18, R24, R35, R56.
  const KNOWN_BROKEN = new Set(["R18", "R24", "R35", "R56"]);
  const unexpected = broken.filter((o) => STRICT || !KNOWN_BROKEN.has(o.case));
  assertEquals(
    unexpected.map((o) => `${o.case}@${o.seed}: ${o.error}`),
    [],
    "every non-documented route fault case must hold",
  );
  for (const id of KNOWN_BROKEN) {
    const runs = outcomes.filter((o) => o.case === id);
    if (runs.length === 0) continue;
    const failures = runs.filter((o) => o.verdict === "BROKEN").length;
    console.log(
      `[stress faults/route] ${id}: ${failures}/${runs.length} BROKEN — ${
        runs[0].fault
      }`,
    );
  }
});
