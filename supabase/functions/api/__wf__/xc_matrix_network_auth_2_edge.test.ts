// xc-matrix-network-auth-2 — EDGE plane of the NETWORK × AUTH cell-2 matrix.
//
// End-to-end pipeline, nothing mocked in the middle:
//
//   real mobile classifier `refreshApiSession()` (apps/mobile/src/account/
//   sessionLifecycle.ts, imported directly — it is plain TS)
//     → fetchFn = the REAL edge handler captured by routesHarness
//       → the edge's own supabase-js `auth.refreshSession()`
//         → scripted GoTrue (`POST /auth/v1/token?grant_type=refresh_token`)
//           driven by a per-cell network schedule.
//
// The ONE implicit sign-out rule: the mobile app signs out only when the
// server REFUSES the refresh token (edge 401/403 ⇒ `SessionRefreshError
// {retryable:false}`). Every other outcome (network trouble, 5xx, malformed
// payloads, rate limits) must classify as retryable. This file drives every
// GoTrue-side terminal outcome through every network pattern between the edge
// and GoTrue and records, per cell, the edge status + the mobile verdict.
//
// Every cell runs twice: once with a 60 s client timeout (so the edge's FINAL
// answer is observed even when supabase-js retries GoTrue for ≈25 s) and once
// with the app's real 15 s refresh timeout (`@app15s`, what a phone actually
// sees). Cells whose observed verdict differs from the expected verdict are
// recorded with `verdict: "FAIL"` in the JSON matrix (replayable by cell id via
// XC_CELL=<id>) and the test fails — a FAIL here is a path that signs the user
// out for something other than a refused refresh token. Rate limits are
// avoided by giving every cell a unique client IP (30 refreshes/min/IP; 30
// auth failures/5 min/IP).
//
// Run (repo root):
//   (cd supabase/functions/api/__wf__ && deno task test --filter xc-matrix-network-auth-2)
// Replay one cell:
//   (cd supabase/functions/api/__wf__ && XC_CELL=upstream_429@online deno task test --filter xc-matrix-network-auth-2)
// Artifacts: artifacts/xc-matrix-network-auth-2/edge/*.json (override via XC_OUT).

import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, userRequest } from "./routesHarness.ts";
import {
  refreshApiSession,
  SessionRefreshError,
} from "../../../../apps/mobile/src/account/sessionLifecycle.ts";

// ─── GoTrue-side terminal outcomes ──────────────────────────────────────────

type Terminal =
  | "ok"
  | "refused_400_refresh_token_not_found"
  | "refused_400_already_used"
  | "refused_401"
  | "refused_403"
  | "upstream_429"
  | "upstream_500"
  | "upstream_502"
  | "upstream_503"
  | "upstream_504"
  | "upstream_520"
  | "malformed_200_non_json"
  | "malformed_200_empty_object"
  | "malformed_200_missing_refresh_token"
  | "malformed_200_expires_in_zero"
  | "net_error_persistent";

/** Whether the mobile app is ALLOWED to sign out for this terminal outcome. */
const EXPECTED: Record<Terminal, "sign_out" | "retry"> = {
  ok: "retry", // success — obviously not a sign-out
  refused_400_refresh_token_not_found: "sign_out",
  refused_400_already_used: "sign_out",
  refused_401: "sign_out",
  refused_403: "sign_out",
  upstream_429: "retry",
  upstream_500: "retry",
  upstream_502: "retry",
  upstream_503: "retry",
  upstream_504: "retry",
  upstream_520: "retry",
  malformed_200_non_json: "retry",
  malformed_200_empty_object: "retry",
  malformed_200_missing_refresh_token: "retry",
  malformed_200_expires_in_zero: "retry",
  net_error_persistent: "retry",
};

const TERMINALS = Object.keys(EXPECTED) as Terminal[];

/** Network pattern between the edge function and GoTrue. `prefixNetErrors`
 * connection failures are injected before the terminal outcome is served. */
type Pattern = "online" | "intermittent_1" | "intermittent_3" | "reconnect_5";
const PATTERNS: Record<Pattern, number> = {
  online: 0,
  intermittent_1: 1,
  intermittent_3: 3,
  reconnect_5: 5,
};

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function serveTerminal(terminal: Terminal, sub: string): Response {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = {
    id: sub,
    aud: "authenticated",
    role: "authenticated",
    email: "user@example.com",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  switch (terminal) {
    case "ok":
      return json(200, {
        access_token: `rotated-access-${sub}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: `rotated-refresh-${sub}`,
        user,
      });
    case "refused_400_refresh_token_not_found":
      return json(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token: Refresh Token Not Found",
      });
    case "refused_400_already_used":
      return json(400, {
        code: 400,
        error_code: "refresh_token_already_used",
        msg: "Invalid Refresh Token: Already Used",
      });
    case "refused_401":
      return json(401, {
        code: 401,
        error_code: "bad_jwt",
        msg: "invalid JWT",
      });
    case "refused_403":
      return json(403, {
        code: 403,
        error_code: "user_banned",
        msg: "User is banned",
      });
    case "upstream_429":
      return json(
        429,
        {
          code: 429,
          error_code: "over_request_rate_limit",
          msg: "Request rate limit reached",
        },
        { "Retry-After": "30" },
      );
    case "upstream_500":
      return json(500, {
        code: 500,
        error_code: "unexpected_failure",
        msg: "Database error",
      });
    case "upstream_502":
      return new Response("<html>502 Bad Gateway</html>", { status: 502 });
    case "upstream_503":
      return json(503, { code: 503, msg: "Service Unavailable" });
    case "upstream_504":
      return new Response("", { status: 504 });
    case "upstream_520":
      return new Response("", { status: 520 });
    case "malformed_200_non_json":
      return new Response("<html>gateway returned html</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    case "malformed_200_empty_object":
      return json(200, {});
    case "malformed_200_missing_refresh_token":
      return json(200, {
        access_token: `rotated-access-${sub}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        user,
      });
    case "malformed_200_expires_in_zero":
      return json(200, {
        access_token: `rotated-access-${sub}`,
        token_type: "bearer",
        expires_in: 0,
        expires_at: expiresAt,
        refresh_token: `rotated-refresh-${sub}`,
        user,
      });
    case "net_error_persistent":
      throw new TypeError("error sending request: connection refused");
  }
}

// ─── Cell execution ─────────────────────────────────────────────────────────

/** The app's own refresh timeout (sessionLifecycle.ts REQUEST_TIMEOUT_MS). */
const APP_REFRESH_TIMEOUT_MS = 15_000;
/** Long enough to observe the edge's final answer through supabase-js retries. */
const OBSERVE_TIMEOUT_MS = 60_000;

interface Cell {
  id: string;
  terminal: Terminal;
  pattern: Pattern;
  prefixNetErrors: number;
  mobileTimeoutMs: number;
  ip: string;
  refreshToken: string;
}

interface CellResult extends Cell {
  expected: "sign_out" | "retry";
  observed: "sign_out" | "retry" | "rotated" | "unexpected_error";
  verdict: "PASS" | "FAIL";
  /** Edge status as seen by the classifier (null ⇒ the app aborted first). */
  edgeStatus: number | null;
  edgeBody: string | null;
  /** Edge status once the handler eventually answered (even after the abort). */
  edgeFinalStatus: number | null;
  edgeFinalMs: number | null;
  gotrueAttempts: number;
  gotrueSequence: string[];
  mobileError:
    | { name: string; message: string; retryable: boolean | null }
    | null;
  durationMs: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
}

interface UpstreamScript {
  remainingNetErrors: number;
  terminal: Terminal;
  attempts: number;
  sequence: string[];
}

/** Per-cell upstream scripts keyed by the refresh token the edge forwards to
 * GoTrue — cells run concurrently (supabase-js retries retryable upstream
 * errors for ≈25 s wall clock, so a sequential run would take ~15 min). */
const scripts = new Map<string, UpstreamScript>();

function installUpstreamInterceptor(harnessFetch: typeof fetch): void {
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (
        url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
        url.includes("grant_type=refresh_token")
      ) {
        const body = init?.body;
        let refreshToken = "";
        try {
          const parsed = JSON.parse(typeof body === "string" ? body : "{}") as {
            refresh_token?: string;
          };
          refreshToken = parsed.refresh_token ?? "";
        } catch {
          // keep default
        }
        const script = scripts.get(refreshToken);
        if (!script) {
          return Promise.resolve(
            new Response(`no upstream script for refresh token`, {
              status: 599,
            }),
          );
        }
        script.attempts += 1;
        if (script.remainingNetErrors > 0) {
          script.remainingNetErrors -= 1;
          script.sequence.push("net_error");
          return Promise.reject(
            new TypeError("error sending request: connection reset by peer"),
          );
        }
        script.sequence.push(script.terminal);
        return Promise.resolve(
          serveTerminal(
            script.terminal,
            refreshToken.split(":")[1] ?? "matrix-user",
          ),
        );
      }
      return harnessFetch(input, init);
    }) as typeof fetch;
}

/** Edge handler invocations still running after the app aborted; awaited
 * before the test ends so nothing leaks past the sanitizer. */
const pendingEdgeAnswers: Promise<unknown>[] = [];
/** Fills in `edgeFinal*` on each result once the late edge answers landed. */
const finalizers: Array<() => void> = [];

async function runCell(
  handler: (request: Request) => Promise<Response>,
  cell: Cell,
): Promise<CellResult> {
  const script: UpstreamScript = {
    remainingNetErrors: cell.prefixNetErrors,
    terminal: cell.terminal,
    attempts: 0,
    sequence: [],
  };
  scripts.set(cell.refreshToken, script);
  let edgeStatus: number | null = null;
  let edgeBody: string | null = null;
  let edgeFinalStatus: number | null = null;
  let edgeFinalMs: number | null = null;
  const started = performance.now();
  // The mobile classifier calls fetchFn(url, init); route that straight into
  // the real edge handler with this cell's client IP. The classifier's abort
  // signal is honoured here exactly as a real fetch would: the promise rejects
  // on abort while the edge keeps working on the request.
  const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
    const edgeRequest = userRequest(
      "POST",
      new URL(url).pathname.replace(/^.*\/api/, ""),
      {
        ip: cell.ip,
        body: JSON.parse(String(init?.body ?? "{}")),
      },
    );
    const answer = handler(edgeRequest).then(async (response) => {
      edgeFinalStatus = response.status;
      edgeFinalMs = Math.round(performance.now() - started);
      return { response, body: await response.clone().text() };
    });
    pendingEdgeAnswers.push(answer.catch(() => undefined));
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      answer.then(({ response, body }) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return;
        edgeStatus = response.status;
        edgeBody = body;
        resolve(response);
      }, (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  };

  const heapUsedBefore = Deno.memoryUsage().heapUsed;
  let observed: CellResult["observed"];
  let mobileError: CellResult["mobileError"] = null;
  try {
    const tokens = await refreshApiSession(
      {
        apiBaseUrl: "http://edge.test/functions/v1/api",
        refreshToken: cell.refreshToken,
      },
      { fetchFn, timeoutMs: cell.mobileTimeoutMs },
    );
    observed = tokens.bearerToken ? "rotated" : "unexpected_error";
  } catch (error) {
    if (error instanceof SessionRefreshError) {
      observed = error.retryable ? "retry" : "sign_out";
      mobileError = {
        name: error.name,
        message: error.message,
        retryable: error.retryable,
      };
    } else {
      observed = "unexpected_error";
      mobileError = {
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
        retryable: null,
      };
    }
  }
  const durationMs = Math.round(performance.now() - started);
  const heapUsedAfter = Deno.memoryUsage().heapUsed;
  const expected = EXPECTED[cell.terminal];
  const verdict: CellResult["verdict"] = cell.terminal === "ok"
    ? (observed === "rotated" ? "PASS" : "FAIL")
    : (observed === expected ? "PASS" : "FAIL");
  const result: CellResult = {
    ...cell,
    expected,
    observed,
    verdict,
    edgeStatus,
    edgeBody,
    edgeFinalStatus,
    edgeFinalMs,
    gotrueAttempts: script.attempts,
    gotrueSequence: script.sequence,
    mobileError,
    durationMs,
    heapUsedBefore,
    heapUsedAfter,
  };
  finalizers.push(() => {
    result.edgeFinalStatus = edgeFinalStatus;
    result.edgeFinalMs = edgeFinalMs;
  });
  return result;
}

function buildCells(): Cell[] {
  const cells: Cell[] = [];
  let n = 0;
  for (const timeout of [OBSERVE_TIMEOUT_MS, APP_REFRESH_TIMEOUT_MS]) {
    for (const terminal of TERMINALS) {
      for (const pattern of Object.keys(PATTERNS) as Pattern[]) {
        // Persistent network failure has no "prefix": the whole schedule is errors.
        if (terminal === "net_error_persistent" && pattern !== "online") {
          continue;
        }
        n += 1;
        const suffix = timeout === APP_REFRESH_TIMEOUT_MS ? "@app15s" : "";
        cells.push({
          id: `${terminal}@${pattern}${suffix}`,
          terminal,
          pattern,
          prefixNetErrors: PATTERNS[pattern],
          mobileTimeoutMs: timeout,
          ip: `198.51.${100 + Math.floor(n / 200)}.${n % 200}`,
          refreshToken: `refresh:${terminal}-${pattern}${suffix}:${n}`,
        });
      }
    }
  }
  return cells;
}

const OUT_DIR = Deno.env.get("XC_OUT") ??
  new URL(
    "../../../../artifacts/xc-matrix-network-auth-2/edge/",
    import.meta.url,
  ).pathname;

Deno.test("xc-matrix-network-auth-2 edge: GoTrue outcome × edge↔GoTrue network → edge status → mobile verdict", async () => {
  const harness = await loadHarness();
  harness.reset();
  installUpstreamInterceptor(globalThis.fetch);

  const only = Deno.env.get("XC_CELL");
  const cells = buildCells().filter((cell) => !only || cell.id === only);
  assert(cells.length > 0, `no cell matches XC_CELL=${only}`);

  const wallStart = performance.now();
  const results = Deno.env.get("XC_SEQUENTIAL")
    ? await (async () => {
      const out: CellResult[] = [];
      for (const cell of cells) out.push(await runCell(harness.handler, cell));
      return out;
    })()
    : await Promise.all(cells.map((cell) => runCell(harness.handler, cell)));
  // Let every edge answer land (handlers keep running after an app-side abort).
  await Promise.allSettled(pendingEdgeAnswers);
  pendingEdgeAnswers.length = 0;
  for (const finalize of finalizers) finalize();
  finalizers.length = 0;
  scripts.clear();
  const wallMs = Math.round(performance.now() - wallStart);

  await Deno.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const failures = results.filter((r) => r.verdict === "FAIL");
  const byTerminal: Record<string, Record<string, string>> = {};
  for (const r of results) {
    byTerminal[r.terminal] ??= {};
    const column = r.mobileTimeoutMs === APP_REFRESH_TIMEOUT_MS
      ? `${r.pattern}@app15s`
      : r.pattern;
    byTerminal[r.terminal][column] = `${
      r.edgeStatus ?? "timeout"
    }→${r.observed}${r.verdict === "FAIL" ? " ✗" : ""}`;
  }
  const report = {
    cell: "matrix-network-auth-2",
    plane:
      "edge (Deno, real handler via routesHarness; real mobile classifier)",
    commit: Deno.env.get("XC_COMMIT") ?? null,
    generatedAt: new Date().toISOString(),
    denoVersion: Deno.version.deno,
    totals: {
      cells: results.length,
      pass: results.length - failures.length,
      fail: failures.length,
    },
    mode: Deno.env.get("XC_SEQUENTIAL") ? "sequential" : "concurrent",
    wallMs,
    heap: Deno.memoryUsage(),
    matrix: byTerminal,
    failures: failures.map((f) => ({
      id: f.id,
      replay:
        `XC_CELL=${f.id} deno task test --filter xc-matrix-network-auth-2`,
      input: {
        refreshToken: f.refreshToken,
        ip: f.ip,
        mobileTimeoutMs: f.mobileTimeoutMs,
        gotrueSequence: f.gotrueSequence,
      },
      expected: f.expected,
      observed: f.observed,
      edgeStatus: f.edgeStatus,
      edgeBody: f.edgeBody,
      edgeFinalStatus: f.edgeFinalStatus,
      edgeFinalMs: f.edgeFinalMs,
      durationMs: f.durationMs,
    })),
    cells: results,
  };
  const path = `${OUT_DIR}edge-matrix-${stamp}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  await Deno.writeTextFile(
    `${OUT_DIR}edge-matrix-latest.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`[xc-matrix-network-auth-2] wrote ${path}`);
  console.table(
    results.map((r) => ({
      cell: r.id,
      edge: r.edgeStatus ??
        `timeout(final ${r.edgeFinalStatus ?? "-"} @${r.edgeFinalMs ?? "-"}ms)`,
      attempts: r.gotrueAttempts,
      ms: r.durationMs,
      observed: r.observed,
      expected: r.expected,
      verdict: r.verdict,
    })),
  );

  globalThis.fetch = harness.realFetch;
  Deno.serve = harness.realServe;

  // Pipeline sanity: every cell reached GoTrue at least once and produced a
  // classification (no unexpected_error); the refusal cells DID sign out (the
  // one allowed implicit sign-out must still work); healthy refreshes rotate.
  for (const r of results) {
    assert(r.gotrueAttempts >= 1, `${r.id}: GoTrue never called`);
    assert(
      r.observed !== "unexpected_error",
      `${r.id}: ${JSON.stringify(r.mobileError)}`,
    );
  }
  for (const r of results.filter((r) => r.expected === "sign_out")) {
    assertEquals(r.observed, "sign_out", `${r.id}: refusal must sign out`);
  }
  for (const r of results.filter((r) => r.terminal === "ok")) {
    assertEquals(r.observed, "rotated", `${r.id}: healthy refresh must rotate`);
  }

  // The invariant under test: nothing but a refused refresh token may end in
  // `sign_out`. Every FAIL cell is listed with its replay command in the JSON.
  assertEquals(
    failures.map((f) =>
      `${f.id}: edge ${
        f.edgeStatus ?? "timeout"
      } → ${f.observed} (expected ${f.expected})`
    ),
    [],
    `${failures.length} cell(s) sign the user out for something other than a refused refresh token — see ${path}`,
  );
});
