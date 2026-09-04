// xc-matrix::XC-ADJ-AUTH-1 — adversarial pin (attack branch devin/attack-fix-322511d1).
//
// Contract under test (refreshSessionRoute, supabase/functions/api/index.ts):
// "401 means GoTrue REFUSED the refresh token ... Everything else is transient
// for the app and must never look like a refusal." The mobile classifier
// (`refreshApiSession`) signs the user out on 401/403.
//
// A 401 from the Supabase API gateway itself — `{"message":"Invalid API key"}`
// (the response when the edge's `apikey` header is wrong: rotated / disabled
// anon key, misconfigured secret) — carries NO GoTrue `error_code` and says
// nothing about the user's refresh token. The candidate maps it to edge 401
// because supabase-js wraps any JSON error body as `AuthApiError` and the route
// only checks `isAuthApiError(error) && status ∈ {400,401,403}`. Result: a
// server-side configuration fault signs EVERY user out instead of being
// relayed as a generic 503 that mobile retries with backoff.
//
// Control cells (must keep passing): a GoTrue refusal WITH an error_code
// (`refresh_token_not_found`, `refresh_token_already_used`, `session_not_found`,
// legacy `invalid_grant`) still yields 401 / sign-out.
//
// Same pipeline as xc_matrix_network_auth_2_edge.test.ts: real mobile
// classifier → real edge handler → edge's supabase-js → scripted GoTrue.
//
// Run (repo root):
//   (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json xc_attack_refresh_gateway_401.test.ts)

import { assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, userRequest } from "./routesHarness.ts";
import {
  refreshApiSession,
  SessionRefreshError,
} from "../../../../apps/mobile/src/account/sessionLifecycle.ts";

type Verdict = "rotated" | "retry" | "sign_out";

interface Cell {
  id: string;
  upstream: () => Response;
  expectedEdge: number;
  expectedVerdict: Verdict;
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const CELLS: Cell[] = [
  // --- attack cells: gateway / infrastructure 401-403 that are NOT a refresh-token refusal
  {
    id: "gateway_401_invalid_api_key_json",
    upstream: () =>
      jsonResponse(401, {
        message: "Invalid API key",
        hint: "Double check your Supabase `anon` or `service_role` API key.",
      }),
    expectedEdge: 503,
    expectedVerdict: "retry",
  },
  {
    id: "gateway_403_json_no_error_code",
    upstream: () => jsonResponse(403, { message: "Forbidden" }),
    expectedEdge: 503,
    expectedVerdict: "retry",
  },
  // --- control cells: genuine GoTrue refusals keep the ONE implicit sign-out
  {
    id: "gotrue_400_refresh_token_not_found",
    upstream: () =>
      jsonResponse(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token: Refresh Token Not Found",
      }),
    expectedEdge: 401,
    expectedVerdict: "sign_out",
  },
  {
    id: "gotrue_400_refresh_token_already_used",
    upstream: () =>
      jsonResponse(400, {
        code: 400,
        error_code: "refresh_token_already_used",
        msg: "Invalid Refresh Token: Already Used",
      }),
    expectedEdge: 401,
    expectedVerdict: "sign_out",
  },
  {
    id: "gotrue_400_legacy_invalid_grant",
    upstream: () =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
      }),
    expectedEdge: 401,
    expectedVerdict: "sign_out",
  },
  {
    id: "gotrue_401_session_not_found",
    upstream: () =>
      jsonResponse(401, {
        code: 401,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      }),
    expectedEdge: 401,
    expectedVerdict: "sign_out",
  },
];

Deno.test(
  "xc attack AUTH-1: a gateway 401/403 without a GoTrue error_code is not a refresh-token refusal → 503 + retry (genuine refusals stay 401)",
  async () => {
    const harness = await loadHarness();
    harness.reset();
    const realFetch = globalThis.fetch;
    const scripts = new Map<string, () => Response>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (
        url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
        url.includes("grant_type=refresh_token")
      ) {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as {
          refresh_token?: string;
        };
        const serve = scripts.get(parsed.refresh_token ?? "");
        if (!serve) {
          return Promise.resolve(new Response("unscripted", { status: 599 }));
        }
        return Promise.resolve(serve());
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const failures: string[] = [];
    try {
      let n = 0;
      for (const cell of CELLS) {
        n += 1;
        const token = `attack:${cell.id}`;
        scripts.set(token, cell.upstream);
        let edgeStatus: number | null = null;
        let edgeBody = "";
        const fetchFn = async (url: string, init?: RequestInit) => {
          const res = await harness.handler(
            userRequest("POST", new URL(url).pathname.replace(/^.*\/api/, ""), {
              ip: `203.0.113.${n}`,
              body: JSON.parse(String(init?.body ?? "{}")),
            }),
          );
          edgeStatus = res.status;
          edgeBody = await res.clone().text();
          return res;
        };
        let verdict: Verdict | string;
        try {
          await refreshApiSession(
            {
              apiBaseUrl: "http://edge.test/functions/v1/api",
              refreshToken: token,
            },
            { fetchFn, timeoutMs: 60_000 },
          );
          verdict = "rotated";
        } catch (error) {
          verdict = error instanceof SessionRefreshError
            ? (error.retryable ? "retry" : "sign_out")
            : `unexpected:${String(error)}`;
        }
        if (
          edgeStatus !== cell.expectedEdge || verdict !== cell.expectedVerdict
        ) {
          failures.push(
            `${cell.id}: edge ${edgeStatus} → mobile ${verdict} ` +
              `(expected edge ${cell.expectedEdge} → ${cell.expectedVerdict}); body=${
                edgeBody.slice(0, 160)
              }`,
          );
        }
      }
    } finally {
      globalThis.fetch = realFetch;
      Deno.serve = harness.realServe;
    }
    assertEquals(
      failures,
      [],
      `${failures.length} cell(s) sign the user out (or fail to) for the wrong reason:\n${
        failures.join("\n")
      }`,
    );
  },
);
