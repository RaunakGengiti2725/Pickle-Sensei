// xc-security adjudication — edge half of the capturedAt log-injection
// candidate. The SQL half (apply_synced_shot echoing sqlerrm with the raw
// capturedAt) is reproduced in supabase/tests/xc_adjudication/xc_adjudication_repro.sql;
// here the RPC stub returns the EXACT string Postgres 16 produced there.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json xc_adjudication_loginjection.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadHarness, TEST_USER_ID, userRequest } from "./routesHarness.ts";

// V8's legacy Date parser treats a parenthesised suffix as a comment, so this
// passes `isIsoDate` (Date.parse) while Postgres rejects the timestamptz cast.
const CANARY_CAPTURED_AT = "Jan 1 2026 (XCSEC_CANARY\n[api] FORGED access log line)";

function shot(capturedAt: string) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
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

Deno.test(
  "control: Date.parse accepts a parenthesised comment that Postgres timestamptz rejects",
  () => {
    assert(!Number.isNaN(Date.parse(CANARY_CAPTURED_AT)), "isIsoDate() lets the canary through");
  },
);

Deno.test(
  "REPRO (defect): client capturedAt passes validation, reaches the RPC verbatim, and the RPC's sqlerrm echo is written to console.error unsanitised",
  async () => {
    const h = await loadHarness();
    h.tables["shots"] = [];
    // Exactly what postgres:16 returned for this input (repro_sql.log, XC-SQL-2 pattern).
    h.rpcs["apply_synced_shot"] =
      `shot.write_failed:invalid input syntax for type timestamp with time zone: "${CANARY_CAPTURED_AT}"`;

    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      const response = await h.handler(
        userRequest("POST", "/v1/shots:sync", { body: { shots: [shot(CANARY_CAPTURED_AT)] } }),
      );
      assertEquals(response.status, 200, "batch is processed");
      const body = await response.json();
      assertEquals(
        body.rejected?.[0]?.code,
        "shot.write_failed",
        "client sees the stable code only",
      );
    } finally {
      console.error = realError;
    }

    const rpcCalls = h.callsTo("/rest/v1/rpc/apply_synced_shot");
    assertEquals(rpcCalls.length, 1, "validation did NOT reject the canary; the RPC was invoked");
    const sent = rpcCalls[0].body as { shot?: { capturedAt?: string } };
    assertEquals(sent.shot?.capturedAt, CANARY_CAPTURED_AT, "capturedAt forwarded verbatim");

    const injected = logged.find((line) => line.includes("XCSEC_CANARY"));
    // DEFECT: expected the log line to carry no client-controlled text (or a
    // sanitized/length-capped detail); observed the raw multi-line canary.
    assert(
      injected,
      `[defect] console.error should carry the client canary; got ${JSON.stringify(logged)}`,
    );
    assertStringIncludes(
      injected,
      "\n[api] FORGED access log line",
      "newline survives → forged second log line",
    );
    assertEquals(TEST_USER_ID.length, 36, "sanity");
  },
);
