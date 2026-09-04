// xc-security XC-SEC-4 — edge half of the capturedAt log-injection finding.
//
// The SQL half (apply_synced_shot echoing sqlerrm with the raw capturedAt) is
// reproduced in supabase/tests/xc_adjudication/xc_adjudication_repro.sql and
// pinned fixed by security_regression.sql (section K). This file pins the edge:
//
//   1. capturedAt is validated with a strict ISO-8601 shape + calendar + range
//      check BEFORE the RPC — V8's legacy Date.parse (which treats a
//      parenthesised suffix as a comment) is no longer the gate, so the canary
//      never reaches the database or the function logs.
//   2. Whatever detail the RPC returns after `shot.write_failed:` is logged as
//      ONE sanitized, length-capped line (control characters stripped), so a
//      hostile detail can never forge a second log line.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json xc_adjudication_loginjection.test.ts

import { assert, assertEquals, assertMatch } from "@std/assert";
import { loadHarness, userRequest } from "./routesHarness.ts";

// V8's legacy Date parser treats a parenthesised suffix as a comment, so this
// passes `Date.parse` while Postgres rejects the timestamptz cast.
const CANARY_CAPTURED_AT = "Jan 1 2026 (XCSEC_CANARY\n[api] FORGED access log line)";

const SHOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

function shot(capturedAt: string) {
  return {
    id: SHOT_ID,
    source: "real",
    analysisPermitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    sessionId: null,
    shotType: "drive",
    cameraView: "side",
    capturedAt,
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind: "scored",
    overallScore: 7.1,
    confidence: 0.9,
    phases: [],
    checkpoints: [],
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "bundle-1",
      poseModelVersion: "pose-1",
      paddleModelVersion: "paddle-1",
      strokeDetectorVersion: "stroke-1",
      phaseModelVersion: "phase-1",
      scoringModelVersion: "scoring-1",
      shotConfigVersion: "config-1",
    },
  };
}

async function captureErrors<T>(run: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    return { result: await run(), logged };
  } finally {
    console.error = realError;
  }
}

Deno.test(
  "control: Date.parse accepts a parenthesised comment that Postgres timestamptz rejects",
  () => {
    assert(!Number.isNaN(Date.parse(CANARY_CAPTURED_AT)), "Date.parse lets the canary through");
  },
);

Deno.test(
  "XC-SEC-4: a canary capturedAt is rejected before the RPC and never reaches console.error",
  async () => {
    const h = await loadHarness();
    h.tables["shots"] = [];
    // If validation ever let the canary through, this is EXACTLY what
    // postgres:16 returned for it before 20260904000000 (repro_sql.log, XC-SQL-2).
    h.rpcs["apply_synced_shot"] =
      `shot.write_failed:invalid input syntax for type timestamp with time zone: "${CANARY_CAPTURED_AT}"`;

    const { result: response, logged } = await captureErrors(() =>
      h.handler(
        userRequest("POST", "/v1/shots:sync", { body: { shots: [shot(CANARY_CAPTURED_AT)] } }),
      ),
    );
    assertEquals(response.status, 200, "batch is processed");
    const body = await response.json();
    assertEquals(body.acceptedIds, []);
    assertEquals(body.rejected?.[0]?.id, SHOT_ID);
    assertEquals(
      body.rejected?.[0]?.code,
      "shot.invalid_payload",
      "a non-ISO capturedAt is a validation error, not a write failure",
    );

    assertEquals(
      h.callsTo("/rest/v1/rpc/apply_synced_shot").length,
      0,
      "the RPC must not be invoked for a malformed capturedAt",
    );
    assertEquals(
      logged.filter((line) => line.includes("XCSEC_CANARY")),
      [],
      "client-controlled text must never reach the function logs",
    );
  },
);

Deno.test(
  "XC-SEC-4: a hostile shot.write_failed detail from the RPC is logged as one sanitized, capped line",
  async () => {
    const h = await loadHarness();
    h.tables["shots"] = [];
    // A (legacy or compromised) RPC result carrying a multi-line, control-
    // character-laden detail. The DB no longer produces this (SQLSTATE only),
    // but the edge must not trust the RPC string either.
    const hostileDetail = `XCSEC_CANARY\n[api] FORGED access log line\r\n\u001b[31m${"x".repeat(2_000)}`;
    h.rpcs["apply_synced_shot"] = `shot.write_failed:${hostileDetail}`;

    const { result: response, logged } = await captureErrors(() =>
      h.handler(
        userRequest("POST", "/v1/shots:sync", {
          body: { shots: [shot("2026-08-31T10:00:00.000Z")] },
        }),
      ),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.rejected?.[0]?.code, "shot.write_failed", "client sees the stable code only");
    assertEquals(
      body.rejected?.[0]?.message.includes("XCSEC_CANARY"),
      false,
      "client message stays generic",
    );

    const writeFailed = logged.filter((line) => line.includes("shot sync write failed"));
    assertEquals(
      writeFailed.length,
      1,
      `exactly one write-failed log line; got ${JSON.stringify(logged)}`,
    );
    const line = writeFailed[0];
    assertEquals(line.includes("\n"), false, "no forged second log line");
    assertEquals(line.includes("\r"), false, "no carriage return");
    assertMatch(line, /^[^\u0000-\u001f\u007f]*$/, "control characters stripped");
    assert(line.length <= 300, `detail is length-capped; got ${line.length} chars`);
  },
);

Deno.test(
  "parseSyncShot: capturedAt must be strict ISO-8601 (UTC), a real calendar instant, and in range",
  async () => {
    const h = await loadHarness();
    const rejected = ["Jan 1 2026 (x)", "infinity", "2026-02-30T00:00:00Z", ""];
    for (const capturedAt of rejected) {
      h.reset();
      h.tables["shots"] = [];
      h.rpcs["apply_synced_shot"] = "accepted";
      const response = await h.handler(
        userRequest("POST", "/v1/shots:sync", { body: { shots: [shot(capturedAt)] } }),
      );
      assertEquals(response.status, 200, JSON.stringify(capturedAt));
      const body = await response.json();
      assertEquals(
        body.rejected?.[0]?.code,
        "shot.invalid_payload",
        `${JSON.stringify(capturedAt)} must be rejected as an invalid payload`,
      );
      assertEquals(body.acceptedIds, [], JSON.stringify(capturedAt));
      assertEquals(
        h.callsTo("/rest/v1/rpc/apply_synced_shot").length,
        0,
        `${JSON.stringify(capturedAt)} must not reach the RPC`,
      );
    }

    h.reset();
    h.tables["shots"] = [];
    h.rpcs["apply_synced_shot"] = "accepted";
    const ok = await h.handler(
      userRequest("POST", "/v1/shots:sync", {
        body: { shots: [shot("2026-08-31T10:00:00.000Z")] },
      }),
    );
    assertEquals(ok.status, 200);
    const okBody = await ok.json();
    assertEquals(okBody.rejected, []);
    assertEquals(okBody.acceptedIds, [SHOT_ID], "a real ISO instant is accepted");
    const rpcCalls = h.callsTo("/rest/v1/rpc/apply_synced_shot");
    assertEquals(rpcCalls.length, 1);
    const sent = rpcCalls[0].body as { shot?: { capturedAt?: string } };
    assertEquals(sent.shot?.capturedAt, "2026-08-31T10:00:00.000Z");
  },
);
