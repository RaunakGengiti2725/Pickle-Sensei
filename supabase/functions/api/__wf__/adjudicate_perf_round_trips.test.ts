// Adjudication repro (xc-performance / perf-edge-latency-n1): counts the
// PostgREST round trips the REAL handler issues per request through the
// shared black-box harness (fetch stubbed, no project touched). Assertions
// pin what 4d812e1a does today, not what it should do.
//
//   deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     supabase/functions/api/__wf__/adjudicate_perf_round_trips.test.ts
import { assert, assertEquals } from "@std/assert";
import { loadHarness, TEST_USER_ID, userRequest } from "./routesHarness.ts";

const uuid = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

const shot = (n: number) => ({
  id: uuid(n),
  source: "real",
  analysisPermitId: uuid(10_000 + n),
  sessionId: null,
  shotType: "forehand_drive",
  cameraView: "side",
  capturedAt: "2026-09-01T00:00:00.000Z",
  timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
  resultKind: "scored",
  overallScore: 7.2,
  confidence: 0.9,
  phases: [],
  checkpoints: [],
  versionVector: {
    appVersion: "1",
    modelBundleVersion: "1",
    poseModelVersion: "1",
    paddleModelVersion: "1",
    strokeDetectorVersion: "1",
    phaseModelVersion: "1",
    scoringModelVersion: "1",
    shotConfigVersion: "1",
  },
});

Deno.test("shots:sync with N=50 fresh shots issues 1 replay SELECT + 50 sequential RPCs", async () => {
  const h = await loadHarness();
  h.reset();
  h.tables["shots"] = [];
  h.rpcs["apply_synced_shot"] = "accepted";
  const shots = Array.from({ length: 50 }, (_, i) => shot(i));
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      ip: "198.51.100.71",
      body: { shots },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.acceptedIds.length, 50);
  const selects = h.callsTo("/rest/v1/shots?");
  const rpcs = h.callsTo("/rest/v1/rpc/apply_synced_shot");
  console.log(
    `[adjudicate] shots:sync N=50 → SELECT=${selects.length} RPC=${rpcs.length}`,
  );
  assertEquals(selects.length, 1);
  assertEquals(rpcs.length, 50);
  assert(
    rpcs.every((call) =>
      Array.isArray((call.body as { shot: unknown }).shot) === false
    ),
  );
});

Deno.test("evaluation/trials with N=50 issues 1 consent read + 50 upserts + 50 ownership SELECTs", async () => {
  const h = await loadHarness();
  h.reset();
  h.tables["consent_records"] = [
    {
      scope: "evaluation_telemetry",
      action: "grant",
      consent_version: "1",
      created_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  h.tables["evaluation_trials"] = [{ id: "x" }];
  const trials = Array.from(
    { length: 50 },
    (_, i) => ({ trialId: uuid(20_000 + i), k: i }),
  );
  const res = await h.handler(
    userRequest("POST", "/v1/me/evaluation/trials", {
      ip: "198.51.100.72",
      body: { trials },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.acceptedTrialIds.length, 50);
  const consent = h.callsTo("/rest/v1/consent_records");
  const trialCalls = h.callsTo("/rest/v1/evaluation_trials");
  const upserts = trialCalls.filter((c) => c.method === "POST");
  const reads = trialCalls.filter((c) => c.method === "GET");
  console.log(
    `[adjudicate] trials N=50 → consent=${consent.length} upsert=${upserts.length} ownershipSELECT=${reads.length}`,
  );
  assertEquals(consent.length, 1);
  assertEquals(upserts.length, 50);
  assertEquals(reads.length, 50);
});

Deno.test("GET /v1/progress returns the ENTIRE progress_daily history (no window) and caches it whole", async () => {
  const h = await loadHarness();
  h.reset();
  // 3 shot types x 730 days = 2190 rows; the stub returns the whole table on
  // every page, so readAllRows stops after the first page (< PAGE_ROWS).
  const rows: unknown[] = [];
  for (let d = 0; d < 730; d++) {
    const day = new Date(Date.UTC(2024, 8, 1) + d * 86_400_000).toISOString()
      .slice(0, 10);
    for (const t of ["forehand_drive", "backhand_drive", "dink"]) {
      rows.push({
        day,
        shot_type: t,
        scoring_model_version: "sm-v1",
        shot_count: 4,
        avg_score: 7.1,
        best_score: 8.4,
      });
    }
  }
  h.tables["progress_daily"] = [];
  h.tables["practice_days"] = [];
  // The shared stub ignores offset/limit; honour them here so readAllRows
  // pages exactly like PostgREST would.
  const stubFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/progress_daily") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? rows.length);
      h.calls.push({
        url: url.toString(),
        method: "GET",
        headers: {},
        body: null,
      });
      return Promise.resolve(
        new Response(JSON.stringify(rows.slice(offset, offset + limit)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return stubFetch(input, init);
  }) as typeof fetch;
  let res: Response;
  try {
    res = await h.handler(
      userRequest("GET", "/v1/progress", { ip: "198.51.100.73" }),
    );
  } finally {
    globalThis.fetch = stubFetch;
  }
  assertEquals(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  const pages = h.callsTo("/rest/v1/progress_daily");
  const url = pages[0]?.url ?? "";
  console.log(
    `[adjudicate] progress rows=${body.series.length} bytes=${text.length} pages=${pages.length} user=${TEST_USER_ID} firstPageUrl=${url}`,
  );
  assertEquals(pages.length, 3);
  assertEquals(body.series.length, 2190);
  assert(text.length > 200_000);
  assert(!/day=gte|day=gt/.test(url));
});
