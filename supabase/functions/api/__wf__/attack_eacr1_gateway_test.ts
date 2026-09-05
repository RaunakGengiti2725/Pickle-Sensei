// Adversarial pins for the EACR-1 auth gateway (a6fb880a) — bootstrap verdict
// classification on the signInWithIdToken path.
//
// The candidate's contract (index.ts authVerdictOf): GoTrue 400/401/403 is a
// credential refusal → 401; a 2xx it cannot read is an outage → 503 generic
// with Retry-After; "everything else is the service, not the credential".
//
// Both cells below are deterministic on a6fb880a:
//   1. GoTrue 200 with the JSON literal `null` escapes the classifier —
//      auth-js's hasSession(null) throws a TypeError before authVerdictOf runs
//      and the route answers 500 "Something went wrong" (no Retry-After).
//   2. GoTrue 4xx that is a FINAL verdict on the account (422 signup_disabled /
//      email_exists, 404, 410) is answered 503 "Sign-in is temporarily
//      unavailable. Please try again." — the app (bootstrap.ts: status >= 500
//      ⇒ retryable) keeps retrying a condition that will never clear. On
//      f702f0f8 these were a terminal 401.
//
//   cd supabase/functions/api/__wf__ && \
//     deno test -A --no-check --config deno.json attack_eacr1_gateway_test.ts
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, SUPABASE_URL, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

type GoTrueFault = (request: Request, url: URL) => Response | Promise<Response> | null;

async function withGoTrue<T>(fault: GoTrueFault, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const handled = await fault(request.clone(), url);
      if (handled) return handled;
    }
    return previous(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const onToken =
  (respond: () => Response): GoTrueFault =>
  (_request, url) =>
    url.pathname === "/auth/v1/token" ? respond() : null;

const goTrueJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let ipCounter = 0;
const freshIp = () => `198.51.102.${(ipCounter += 1)}`;

const bootstrapRequest = (ip: string) =>
  userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken(), body: {} });

const GENERIC_UNAVAILABLE = JSON.stringify({
  error: { message: "Sign-in is temporarily unavailable. Please try again." },
});

Deno.test(
  "ATTACK EACR-1: bootstrap × GoTrue 200 `null` body → 503 generic with Retry-After (not 500)",
  async () => {
    h.reset();
    const ip = freshIp();
    let attempts = 0;
    const response = await withGoTrue(
      onToken(() => {
        attempts += 1;
        return new Response("null", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
      () => h.handler(bootstrapRequest(ip)),
    );
    const body = await response.text();
    assertEquals(attempts, 1, "a 2xx answer is final: no retry");
    assertEquals(
      response.status,
      503,
      `a 2xx the edge cannot read is an outage (503), got ${response.status} ${body}`,
    );
    assert(response.headers.get("Retry-After"), "a 503 carries Retry-After");
    assertEquals(body, GENERIC_UNAVAILABLE);
  },
);

// GoTrue error codes that are verdicts on the ACCOUNT, not on the service:
// nothing the client can do by retrying will change them.
const finalFourXx: Array<[string, () => Response]> = [
  [
    "422 signup_disabled",
    () =>
      goTrueJson(422, {
        code: 422,
        error_code: "signup_disabled",
        msg: "Signups not allowed for this instance",
      }),
  ],
  [
    "422 email_exists",
    () =>
      goTrueJson(422, {
        code: 422,
        error_code: "email_exists",
        msg: "Email address already registered by another user",
      }),
  ],
  ["404", () => goTrueJson(404, { code: 404, msg: "not found" })],
  ["410", () => new Response("", { status: 410 })],
];

for (const [label, respond] of finalFourXx) {
  Deno.test(
    `ATTACK EACR-1: bootstrap × GoTrue ${label} is a final verdict — not 503 "temporarily unavailable"`,
    async () => {
      h.reset();
      const ip = freshIp();
      const response = await withGoTrue(onToken(respond), () => h.handler(bootstrapRequest(ip)));
      const body = await response.text();
      assert(
        response.status >= 400 && response.status < 500 && response.status !== 429,
        `GoTrue ${label} is a 4xx verdict on the identity/account; the edge answered ` +
          `${response.status} ${body} which the app treats as retryable (bootstrap.ts: status >= 500 || 429)`,
      );
      assertNotEquals(
        body,
        GENERIC_UNAVAILABLE,
        "a final refusal must not read as a transient outage",
      );
    },
  );
}
