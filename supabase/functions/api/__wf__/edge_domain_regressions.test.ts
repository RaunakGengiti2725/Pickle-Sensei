// Regression pins for the edge-domain adjudication (EDR) findings that were
// fixed on the integration branch. The failing reproductions lived in
// adjudicate_edge_domain_routes.repro.ts (not swept by `deno task test`); the
// pins below keep the fixed behaviour in the suite.

import { assertEquals } from "jsr:@std/assert@1";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

type FetchFn = typeof fetch;

async function withFetchIntercept<T>(
  intercept: (request: Request) => Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const owned = await intercept(request.clone());
    if (owned) return owned;
    return inner(input, init);
  }) as FetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Orders a `day` column the way PostgREST does before applying `Range`. */
function orderedSlice(
  request: Request,
  total: number,
  dayAt: (index: number) => string,
): Array<{ day: string }> {
  const url = new URL(request.url);
  const offset = url.searchParams.get("offset");
  const limit = url.searchParams.get("limit");
  const range = request.headers.get("range") ?? "0-999";
  const [from, to] =
    offset !== null && limit !== null
      ? [Number(offset), Number(offset) + Number(limit) - 1]
      : range.split("-").map(Number);
  const order = url.searchParams.get("order") ?? "day.asc";
  const descending = order.startsWith("day.desc");
  const rows: Array<{ day: string }> = [];
  for (let i = from; i <= Math.min(to, total - 1); i += 1) {
    rows.push({ day: dayAt(descending ? total - 1 - i : i) });
  }
  return rows;
}

// ─── EDR-C: GET /v1/progress pages newest-first so MAX_PAGES never drops today ──

Deno.test(
  "EDR-C: progress with more practice_days rows than MAX_PAGES*PAGE_ROWS keeps today's row (practicedToday true)",
  async () => {
    h.reset();
    const ip = "203.0.113.230";
    const auth = { token: fakeGoogleIdToken("edc00001-0000-4000-8000-000000000001") };
    const total = 20_001;
    const today = Math.floor(Date.now() / 86_400_000);
    const dayAt = (index: number) =>
      new Date((today - (total - 1 - index)) * 86_400_000).toISOString().slice(0, 10);
    const practiceDayRequests: string[] = [];

    const res = await withFetchIntercept(
      async (request) => {
        if (request.method !== "GET") return null;
        if (request.url.includes("/rest/v1/progress_daily")) return jsonResponse(200, []);
        if (request.url.includes("/rest/v1/practice_days")) {
          practiceDayRequests.push(new URL(request.url).searchParams.get("order") ?? "");
          return jsonResponse(200, orderedSlice(request, total, dayAt));
        }
        return null;
      },
      () => h.handler(userRequest("GET", "/v1/progress", { ...auth, ip })),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      streak: { practicedToday: boolean; currentDays: number; lastPracticeDate: string | null };
    };
    assertEquals(body.streak.practicedToday, true, JSON.stringify(body.streak));
    assertEquals(body.streak.lastPracticeDate, dayAt(total - 1));
    assertEquals(body.streak.currentDays, 20_000, "the 20 fetched pages form the current streak");
    assertEquals(practiceDayRequests.length, 20, "paging stops at MAX_PAGES");
    for (const order of practiceDayRequests) assertEquals(order, "day.desc");
  },
);

Deno.test(
  "EDR-C: progress series is returned chronologically regardless of read order",
  async () => {
    h.reset();
    const ip = "203.0.113.231";
    const auth = { token: fakeGoogleIdToken("edc00002-0000-4000-8000-000000000002") };
    h.tables.practice_days = [];
    h.tables.progress_daily = [
      {
        day: "2026-03-02",
        shot_type: "dink",
        scoring_model_version: "scoring-1",
        shot_count: 1,
        avg_score: 7.5,
        best_score: 7.5,
      },
      {
        day: "2026-03-01",
        shot_type: "forehand_drive",
        scoring_model_version: "scoring-1",
        shot_count: 2,
        avg_score: 6,
        best_score: 6.5,
      },
      {
        day: "2026-03-01",
        shot_type: "dink",
        scoring_model_version: "scoring-1",
        shot_count: 1,
        avg_score: 5,
        best_score: 5,
      },
    ];
    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      series: Array<{ day: string; shot_type: string; avg_score: number }>;
    };
    assertEquals(
      body.series.map((row) => `${row.day}/${row.shot_type}`),
      ["2026-03-01/dink", "2026-03-01/forehand_drive", "2026-03-02/dink"],
    );
    assertEquals(
      body.series.map((row) => row.avg_score),
      [50, 60, 75],
    );
  },
);

// ─── EDR-G1: user-facing legal copy hard rule (dossier §0 rule 4) ──────────────

Deno.test("EDR-G1: /privacy, /terms and the support page never mention forbidden terms", () => {
  const hits: string[] = [];
  for (const [name, text] of [
    ["privacy", PRIVACY_POLICY_TEXT],
    ["terms", TERMS_TEXT],
    ["support", SUPPORT_TEXT],
  ] as const) {
    for (const term of [
      "Google Play",
      "DUPR",
      "Android",
      "guest mode",
      "Live Court",
      "SwingVision",
      "PB Vision",
      "Selkirk",
      "JOOLA",
    ]) {
      const count = text.split(term).length - 1;
      if (count > 0) hits.push(`${name}: "${term}" ×${count}`);
    }
  }
  assertEquals(hits, [], `forbidden terms in legal copy: ${hits.join("; ")}`);
});
