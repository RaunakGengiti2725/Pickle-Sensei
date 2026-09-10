// W04-06 ADVERSARY — Edge attacks on POST /v1/offline/grants after the
// candidate (fbc1cc99) let registered-but-unattested installations receive a
// grant and made the route echo the RPC's attestation state. Black-box through
// the REAL edge handler (routesHarness stubs Supabase at the fetch layer).
// Every test asserts the behaviour the candidate claims; a failing test is a
// confirmed break.
//
//   ATK-E1  body boundaries as RAW JSON text (1e999, -0, 2.0, NaN, 2.5, "2",
//           true, null, arrays, >64 KiB, a 128/129-char key, control
//           characters) — refused before any RPC or forwarded exactly
//   ATK-E2  the caller cannot smuggle an attestation: extra body keys
//           (attested, attestationState, p_attested, device_id, user_id) never
//           reach the RPC body and never reach the response
//   ATK-E3  network failure at each step: signing key absent, release policy
//           RPC 5xx, grant RPC 500 / 429 / 503 / 302 / thrown network error /
//           empty row set / two rows — generic 503, nothing signed, no grant
//           generation spent before the RPC, no upstream detail leaked
//   ATK-E4  attestation state values on an accepted row: only the two exact
//           strings are echoed and signed; true / 1 / "ATTESTED" / "" / null /
//           missing fail closed with the row_malformed audit
//   ATK-E5  rollout skew: a database still on BASE answers
//           offline.device_not_attested — the candidate edge fn fails closed
//           (generic 503, unexpected_rpc_result audit), never signs
//   ATK-E6  copy: every coded refusal and the 400 message of the two routes
//           carry none of the terms APP_STORE_SUBMISSION.md forbids and no
//           accuracy / superlative claims

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  captureConsole,
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const REGISTER_PATH = "/v1/devices/register";
const GRANTS_PATH = "/v1/offline/grants";
const REGISTER_RPC = "/rest/v1/rpc/register_offline_device";
const GRANT_RPC = "/rest/v1/rpc/issue_offline_grant";
const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const KID = "atk-w04-06-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-atk-w04-06";
const DEVICE_ID = "33333333-3333-4333-8333-333333333336";
const GRANT_ID = "44444444-4444-4444-8444-444444444446";
const TICKET_A = "55555555-5555-4555-8555-555555555561";
const TICKET_B = "55555555-5555-4555-8555-555555555562";
const DAY = 86_400;

const keyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

function freeRow(attestationState: unknown = "unattested"): Record<string, unknown> {
  const issuedAt = nowSeconds() - 1;
  return {
    result: "accepted",
    grant_id: GRANT_ID,
    generation: 1,
    entitlement_source: "identity_lifetime_free",
    issued_at: iso(issuedAt),
    expires_at: iso(issuedAt + 7 * DAY),
    entitlement_expires_at: null,
    ticket_ids: [TICKET_A, TICKET_B],
    attestation_state: attestationState,
  };
}

function refusedRow(result: string): Record<string, unknown> {
  return {
    result,
    grant_id: null,
    generation: null,
    entitlement_source: null,
    issued_at: null,
    expires_at: null,
    entitlement_expires_at: null,
    ticket_ids: null,
    attestation_state: null,
  };
}

let userSeq = 0;
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0406-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function reset(options: { signingKey?: boolean } = {}): void {
  h.reset();
  if (options.signingKey === false) Deno.env.delete(SIGNING_ENV);
  else Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  h.rpcs.register_offline_device = [
    { result: "accepted", device_id: DEVICE_ID, attestation_state: "unattested" },
  ];
  h.rpcs.issue_offline_grant = [freeRow()];
}

async function post(path: string, body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", path, { token, body }));
}

/** The body as raw text — JSON.stringify would turn 1e999 into null and -0 into 0. */
async function postRaw(path: string, text: string, token: string): Promise<Response> {
  return await h.handler(
    new Request(`http://edge.test/functions/v1/api${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-forwarded-for": "203.0.113.46",
        "Content-Type": "application/json",
      },
      body: text,
    }),
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorOf(body: Record<string, unknown>): { code?: string; message?: string } {
  const error = body.error;
  return error && typeof error === "object" ? (error as { code?: string; message?: string }) : {};
}

function signedPayload(grant: unknown): Record<string, unknown> {
  const compact = (grant as { compactJws: string }).compactJws;
  const payload = compact.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload)) as Record<string, unknown>;
}

type Logs = Array<{ level: string; args: unknown[] }>;
function auditReasons(logs: Logs): string[] {
  return logs
    .flatMap((entry) => entry.args)
    .filter(
      (arg): arg is { evt: string; reason?: string } =>
        typeof arg === "object" &&
        arg !== null &&
        (arg as { evt?: unknown }).evt === "offline_grant_audit",
    )
    .map((entry) => entry.reason ?? "");
}

// ---------------------------------------------------------------------------
// ATK-E1 body boundaries
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-E1: requestedTickets boundary values as raw JSON — non-integers and out-of-range are refused before any RPC",
  async () => {
    reset();
    const key = JSON.stringify(INSTALLATION_KEY);
    for (const raw of [
      "1e999",
      "-1e999",
      "2.5",
      "-1",
      "3",
      "2.0000000001",
      '"2"',
      "true",
      "[]",
      "{}",
      "[2]",
    ]) {
      const response = await postRaw(
        GRANTS_PATH,
        `{"installationKeyId":${key},"requestedTickets":${raw}}`,
        freshUser().token,
      );
      assertEquals(response.status, 400, `requestedTickets=${raw}`);
      assertEquals(errorOf(await readJson(response)).code, "offline.invalid_input");
    }
    // Not JSON at all.
    for (const raw of [
      `{"installationKeyId":${key},"requestedTickets":NaN}`,
      `{"installationKeyId":${key},"requestedTickets":Infinity}`,
      `{"installationKeyId":${key},"requestedTickets":}`,
      "[]",
      '"string"',
      "42",
      "null",
    ]) {
      const response = await postRaw(GRANTS_PATH, raw, freshUser().token);
      assertEquals(response.status, 400, raw);
      await response.text();
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0, "no grant generation spent by a refused body");
    assertEquals(h.callsTo(POLICY_RPC).length, 0);
  },
);

Deno.test(
  "ATK-E1: -0, 2.0 and 1E0 are integers in range and are forwarded as 0, 2 and 1; null falls back to the default 2",
  async () => {
    reset();
    const user = freshUser();
    const key = JSON.stringify(INSTALLATION_KEY);
    const cases: Array<[string, number]> = [
      ["-0", 0],
      ["2.0", 2],
      ["1E0", 1],
      ["0", 0],
      ["null", 2],
    ];
    for (const [raw, forwarded] of cases) {
      h.calls.length = 0;
      const response = await postRaw(
        GRANTS_PATH,
        `{"installationKeyId":${key},"requestedTickets":${raw}}`,
        user.token,
      );
      assertEquals(response.status, 200, `requestedTickets=${raw}`);
      await response.text();
      const calls = h.callsTo(GRANT_RPC);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].body, {
        p_installation_key_id: INSTALLATION_KEY,
        p_requested_tickets: forwarded,
      });
      assert(
        !Object.is((calls[0].body as { p_requested_tickets: number }).p_requested_tickets, -0),
        "the RPC never receives a negative zero",
      );
    }
  },
);

Deno.test(
  "ATK-E1: installation key boundaries — 128 chars forwarded verbatim; 129 chars, control characters, unicode, leading punctuation, wrong types refused before any RPC",
  async () => {
    reset();
    const user = freshUser();
    const k128 = "k" + "x".repeat(127);
    let response = await post(GRANTS_PATH, { installationKeyId: k128 }, user.token);
    assertEquals(response.status, 200);
    const body = await readJson(response);
    assertEquals(h.callsTo(GRANT_RPC)[0].body, {
      p_installation_key_id: k128,
      p_requested_tickets: 2,
    });
    // The signed grant binds the exact key.
    const payload = signedPayload(body.grant);
    assertEquals(JSON.stringify(payload).includes(k128), true);

    h.calls.length = 0;
    for (const bad of [
      "k" + "x".repeat(128),
      "key\n",
      "key\r",
      "key\t",
      "\nkey",
      "key\u0000",
      "-key",
      ".key",
      ":key",
      "_key",
      "key/slash",
      "clé",
      "ke y",
      " key",
      "key ",
      "",
      128,
      null,
      true,
      ["k"],
      { k: 1 },
    ]) {
      response = await post(GRANTS_PATH, { installationKeyId: bad }, freshUser().token);
      assertEquals(response.status, 400, JSON.stringify(bad));
      assertEquals(errorOf(await readJson(response)).code, "offline.invalid_input");
    }
    response = await post(GRANTS_PATH, {}, user.token);
    assertEquals(response.status, 400);
    await response.text();
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
  },
);

Deno.test("ATK-E1: an oversized body is refused (413) before any RPC", async () => {
  reset();
  const user = freshUser();
  const response = await postRaw(
    GRANTS_PATH,
    `{"installationKeyId":"${INSTALLATION_KEY}","padding":"${"p".repeat(70_000)}"}`,
    user.token,
  );
  assertEquals(response.status, 413);
  await response.text();
  assertEquals(h.callsTo(GRANT_RPC).length, 0);
});

// ---------------------------------------------------------------------------
// ATK-E2 attestation smuggling through the body
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-E2: extra body keys never reach the RPC and the response echoes the ROW's state, not the caller's claim",
  async () => {
    reset();
    const user = freshUser();
    const response = await post(
      GRANTS_PATH,
      {
        installationKeyId: INSTALLATION_KEY,
        requestedTickets: 2,
        attested: true,
        attestationState: "attested",
        attestation_state: "attested",
        p_attested: true,
        p_attestation_state: "attested",
        p_installation_key_id: "someone-elses-key",
        device_id: "99999999-9999-4999-8999-999999999999",
        user_id: "99999999-9999-4999-8999-999999999998",
        generation: 999,
      },
      user.token,
    );
    assertEquals(response.status, 200);
    const body = await readJson(response);
    assertEquals(body.attestationState, "unattested");
    const calls = h.callsTo(GRANT_RPC);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].body, {
      p_installation_key_id: INSTALLATION_KEY,
      p_requested_tickets: 2,
    });
    assertEquals(calls[0].headers.authorization, `Bearer session-for-${user.sub}`);
    const payload = signedPayload(body.grant);
    assertEquals(JSON.stringify(payload).toLowerCase().includes("attest"), false);
    assertEquals(payload.sub, user.sub);
  },
);

Deno.test(
  "ATK-E2: registration never forwards a caller-claimed attestation, whatever the key spelling",
  async () => {
    reset();
    const user = freshUser();
    for (const claim of [
      { attested: true },
      { attested: "true" },
      { attestationState: "attested" },
      { attestation_state: "attested" },
      { p_attested: true },
      { appAttest: { verified: true } },
    ]) {
      h.calls.length = 0;
      const response = await post(
        REGISTER_PATH,
        { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production", ...claim },
        user.token,
      );
      assertEquals(response.status, 200, JSON.stringify(claim));
      const body = await readJson(response);
      assertEquals((body.device as { attestationState: string }).attestationState, "unattested");
      const calls = h.callsTo(REGISTER_RPC);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].body, {
        p_installation_key_id: INSTALLATION_KEY,
        p_attestation_environment: "production",
        p_attested: false,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// ATK-E3 network failure at each step
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-E3: signing key absent — generic 503, no RPC at all (no generation spent)",
  async () => {
    reset({ signingKey: false });
    const user = freshUser();
    const { result: response, logs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    );
    assertEquals(response.status, 503);
    const body = await readJson(response);
    assertEquals(errorOf(body).code, undefined);
    assertEquals(body.grant, undefined);
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
    assertEquals(h.callsTo(POLICY_RPC).length, 0);
    assert(
      logs.some((entry) => entry.level === "error"),
      "the detail is logged server-side",
    );
  },
);

Deno.test(
  "ATK-E3: release policy RPC fails — generic 503, the grant RPC is never called",
  async () => {
    reset();
    h.rpcErrors.read_analysis_release_policy = 500;
    const user = freshUser();
    const { result: response } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    );
    assertEquals(response.status, 503);
    const body = await readJson(response);
    assertEquals(body.grant, undefined);
    assertEquals(h.callsTo(GRANT_RPC).length, 0, "no generation spent");
  },
);

Deno.test(
  "ATK-E3: grant RPC 500 / 429 / 503 / 502 — generic 503 body, no signed grant, no upstream detail in the body",
  async () => {
    for (const status of [500, 429, 503, 502, 400, 401, 403, 404]) {
      reset();
      h.rpcErrors.issue_offline_grant = status;
      const user = freshUser();
      const { result: response } = await captureConsole(() =>
        post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
      );
      assertEquals(response.status, 503, `rpc ${status}`);
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      assertEquals(body.grant, undefined);
      assertEquals(errorOf(body).code, undefined);
      assertEquals(text.includes("injected rpc failure"), false, "no upstream detail leaks");
      assertEquals(text.includes("XX000"), false);
      assertMatch(errorOf(body).message ?? "", /temporarily unavailable/);
      assertEquals(h.callsTo(GRANT_RPC).length, 1);
    }
  },
);

Deno.test(
  "ATK-E3: grant RPC answers a redirect, a thrown network error, an empty row set or two rows — 503, nothing signed",
  async () => {
    const user = freshUser();
    // 302 with a Location the client must not follow into a grant.
    reset();
    h.respond = (call) =>
      call.url.includes(GRANT_RPC)
        ? new Response(null, {
            status: 302,
            headers: { Location: `${SUPABASE_URL}/rest/v1/rpc/issue_offline_grant?x=1` },
          })
        : null;
    let { result: response } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    );
    assert(response.status !== 200, `redirect answered ${response.status}`);
    assertEquals((await readJson(response)).grant, undefined);

    // The network itself fails after the request left.
    reset();
    h.respond = (call) => {
      if (call.url.includes(GRANT_RPC)) throw new TypeError("connection reset by peer");
      return null;
    };
    ({ result: response } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    ));
    assertEquals(response.status, 503);
    assertEquals((await readJson(response)).grant, undefined);

    // Empty row set / two rows / a scalar.
    for (const data of [[], [freeRow(), freeRow()], "accepted", null, 42, { result: "accepted" }]) {
      reset();
      h.rpcs.issue_offline_grant = data;
      const { result: r, logs } = await captureConsole(() =>
        post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
      );
      const text = await r.text();
      assert(r.status !== 200, `rpc data ${JSON.stringify(data)} answered 200: ${text}`);
      assertEquals(text.includes("compactJws"), false, "nothing signed");
      if (Array.isArray(data)) {
        assertEquals(auditReasons(logs).includes("row_malformed"), true, JSON.stringify(data));
      }
    }
  },
);

// ---------------------------------------------------------------------------
// ATK-E4 attestation state values on an accepted row
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-E4: only the exact strings 'attested' / 'unattested' are echoed and signed; anything else fails closed with the row_malformed audit",
  async () => {
    for (const state of ["attested", "unattested"]) {
      reset();
      const user = freshUser();
      h.rpcs.issue_offline_grant = [freeRow(state)];
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      assertEquals(response.status, 200, state);
      const body = await readJson(response);
      assertEquals(body.attestationState, state);
      assertEquals(
        JSON.stringify(signedPayload(body.grant)).toLowerCase().includes("attest"),
        false,
      );
    }
    for (const state of [
      true,
      1,
      "ATTESTED",
      "Attested",
      " attested",
      "attested ",
      "",
      null,
      undefined,
      ["attested"],
      { state: "attested" },
      "verified",
      "pending",
    ]) {
      reset();
      const user = freshUser();
      const row = freeRow(state);
      if (state === undefined) delete row.attestation_state;
      h.rpcs.issue_offline_grant = [row];
      const { result: response, logs } = await captureConsole(() =>
        post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
      );
      assertEquals(response.status, 503, JSON.stringify(state));
      const text = await response.text();
      assertEquals(text.includes("compactJws"), false);
      assertEquals(text.includes("attestationState"), false);
      assertEquals(auditReasons(logs), ["row_malformed"], JSON.stringify(state));
    }
  },
);

// ---------------------------------------------------------------------------
// ATK-E5 rollout skew
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-E5: a database still on BASE (offline.device_not_attested) or an unknown refusal — the candidate edge fn fails closed with a generic 503 and audits unexpected_rpc_result",
  async () => {
    const user = freshUser();
    for (const result of [
      "offline.device_not_attested",
      "offline.device_deleted",
      "accepted ",
      "ACCEPTED",
    ]) {
      reset();
      h.rpcs.issue_offline_grant = [refusedRow(result)];
      const { result: response, logs } = await captureConsole(() =>
        post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
      );
      assertEquals(response.status, 503, result);
      const text = await response.text();
      assertEquals(text.includes("compactJws"), false);
      assertEquals(text.includes(result), false, "the unknown code is not echoed");
      assertEquals(auditReasons(logs), ["unexpected_rpc_result"], result);
    }
    // The known refusals of the candidate map to their coded statuses.
    for (const [result, status] of [
      ["offline.device_revoked", 403],
      ["offline.device_not_registered", 409],
      ["access.paywall_required", 402],
      ["offline.invalid_input", 400],
    ] as Array<[string, number]>) {
      reset();
      h.rpcs.issue_offline_grant = [refusedRow(result)];
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      assertEquals(response.status, status, result);
      const body = await readJson(response);
      assertEquals(errorOf(body).code, result);
      assertEquals(body.grant, undefined);
    }
  },
);

// ---------------------------------------------------------------------------
// ATK-E6 copy
// ---------------------------------------------------------------------------

const FORBIDDEN_COPY =
  /android|google play|guest|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s*%|percent|accura|best|most |#1|world|leading|guarantee|as good as|replace(s|d)? (a|your) coach|ai coach/i;

Deno.test(
  "ATK-E6: every user-facing refusal message of the two routes obeys APP_STORE_SUBMISSION.md (no forbidden terms, no accuracy or superlative claims)",
  async () => {
    const user = freshUser();
    const messages: string[] = [];
    for (const result of [
      "offline.device_revoked",
      "offline.device_not_registered",
      "access.paywall_required",
      "offline.invalid_input",
    ]) {
      reset();
      h.rpcs.issue_offline_grant = [refusedRow(result)];
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      const body = await readJson(response);
      messages.push(errorOf(body).message ?? "");
    }
    reset();
    let response = await post(GRANTS_PATH, { installationKeyId: "" }, user.token);
    messages.push(errorOf(await readJson(response)).message ?? "");
    for (const result of ["offline.invalid_input", "offline.device_environment_mismatch"]) {
      reset();
      h.rpcs.register_offline_device = [{ result, device_id: null, attestation_state: null }];
      response = await post(
        REGISTER_PATH,
        { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
        user.token,
      );
      const body = await readJson(response);
      const message = errorOf(body).message;
      if (message) messages.push(message);
    }
    reset({ signingKey: false });
    ({ result: response } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    ));
    messages.push(errorOf(await readJson(response)).message ?? "");

    assert(messages.length >= 7, `collected ${messages.length} messages`);
    for (const message of messages) {
      assert(message.length > 0, "every refusal carries a message");
      assertEquals(FORBIDDEN_COPY.test(message), false, message);
      assertStringIncludes(message, ".", "a full sentence");
    }
  },
);
