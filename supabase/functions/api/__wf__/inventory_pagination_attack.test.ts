// W07-06 ADVERSARIAL pins against candidate da57d8f7 (owner inventory
// pagination). Each test is one attack at a failure boundary of
// readOwnerInventory / the keyset builders / GET /v1/progress. Attacks that the
// candidate survives are kept as regression pins; attacks it does not survive
// are the reported breaks (their assertions describe the EXPECTED behaviour and
// fail on the candidate).
//
// Attacks:
//   A1 boundary   — an honest inventory of exactly INVENTORY_MAX_PAGES full pages
//   A2 corrupt    — a page whose rows are out of keyset order (last row ≠ min)
//   A3 boundary   — numeric keyset values above 2^53 (JSON precision loss)
//   A4 replay     — a row re-served pages later (non-adjacent duplicate)
//   A5 corrupt    — null / sparse / object-keyed rows inside a page
//   A6 network    — 429+Retry-After, 3xx, empty-body 5xx, aborted fetch mid-read
//   A7 authz      — concurrent owners: every page stays scoped to its owner
//   A8 concurrency— rows deleted/inserted mid-read (keyset stability)
//   A9 boundary   — hostile key values (quotes, backslashes, commas, parens,
//                   empty strings, logic keywords) exactly at page boundaries
//   A10 network   — route: 429+Retry-After / redirect / HTML body mid-read → 503
//   A11 corrupt   — route: page overflow / object page mid-read → 503
//   A12 reentrancy— route: coalesced same-owner requests during a failing read

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { InventoryPage, KeysetColumn } from "../accountDeletionOperations.ts";
import { postgrestSelect, type StandInOptions } from "./postgrestStandIn.ts";
import {
  captureConsole,
  fakeGoogleIdToken,
  loadHarness,
  type RecordedCall,
  userRequest,
} from "./routesHarness.ts";

// Dynamic so this file still loads on BASE_SHA (where the exports do not exist).
const ops = await import("../accountDeletionOperations.ts");

const h = await loadHarness();

const PAGE = 1_000;

type Row = Record<string, string | number>;

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const isoDay = (dayIndex: number): string =>
  new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);

const todayIndex = (): number => Math.floor(Date.now() / 86_400_000);

function practiceDays(total: number): Row[] {
  const today = todayIndex();
  const rows: Row[] = [];
  for (let offset = 0; offset < total; offset += 1) rows.push({ day: isoDay(today - offset) });
  return rows;
}

function progressTable(url: URL): string {
  return url.pathname.slice("/rest/v1/".length);
}

const seriesKey = (p: { day: string; shot_type: string; scoring_model_version: string }) =>
  `${p.day}\u0000${p.shot_type}\u0000${p.scoring_model_version}`;

interface ProgressBody {
  series: Array<{ day: string; shot_type: string; scoring_model_version: string }>;
  streak: { practicedToday: boolean; currentDays: number; lastPracticeDate: string | null };
}

interface Item {
  id: number;
}

type ItemReader = Parameters<typeof ops.readOwnerInventory<Item, number>>[0];

/** Honest DESCENDING keyset source over ids total-1 … 0 (the shipping
 * direction): `readPage(cursor)` serves rows strictly below the cursor. */
function honestDescSource(total: number, pageRows: number) {
  const calls: Array<number | null> = [];
  const reader: ItemReader = {
    readPage(cursor, limit) {
      calls.push(cursor);
      const start = cursor === null ? total - 1 : cursor - 1;
      const data: Item[] = [];
      for (let id = start; id >= 0 && data.length < limit; id -= 1) data.push({ id });
      return Promise.resolve({ data, error: null });
    },
    cursorAfter: (row) => row.id,
    cursorKey: (cursor) => String(cursor),
    pageRows,
  };
  return { reader, calls };
}

// ─── A1: page budget boundary ────────────────────────────────────────────────

Deno.test(
  "W07-06 attack A1: an honest inventory of exactly INVENTORY_MAX_PAGES full pages is read completely",
  async () => {
    // INVENTORY_MAX_PAGES is documented as the budget for "a source that never
    // serves an empty page" (1_000_000 rows at the shipping page size). An
    // HONEST source with exactly that many rows serves MAX_PAGES full pages and
    // then its empty proof page — it is finite, and nothing about it is a runaway.
    const control = honestDescSource(ops.INVENTORY_MAX_PAGES - 1, 1);
    const controlResult = await ops.readOwnerInventory<Item, number>(control.reader);
    assertEquals(controlResult.status, "COMPLETE", "MAX_PAGES-1 rows: full pages + proof fit");
    assertEquals(controlResult.rows.length, ops.INVENTORY_MAX_PAGES - 1);

    const { reader, calls } = honestDescSource(ops.INVENTORY_MAX_PAGES, 1);
    const result = await ops.readOwnerInventory<Item, number>(reader);
    assertEquals(
      result.status,
      "COMPLETE",
      JSON.stringify({
        status: result.status,
        reason: result.status === "INCOMPLETE" ? result.reason : null,
        pagesRead: calls.length,
        rows: result.rows.length,
        note: "exactly MAX_PAGES full pages from an honest finite source: the proof page is never requested",
      }),
    );
    assertEquals(result.rows.length, ops.INVENTORY_MAX_PAGES);
  },
);

// ─── A2: out-of-order page ───────────────────────────────────────────────────

Deno.test(
  "W07-06 attack A2: a page served out of keyset order must not silently skip the rows above its last row",
  async () => {
    // The source honours the cursor filter (rows strictly below it) but does
    // not honour the requested order inside a page: it serves the two newest
    // rows and then the OLDEST remaining row last. A reader that positions the
    // cursor at "the last row of the page" then asks for rows below the oldest
    // row → an empty page → COMPLETE with 3 of 10 rows. Nothing repeats, so the
    // duplicate check cannot see it.
    const total = 10;
    let calls = 0;
    const reader: ItemReader = {
      readPage(cursor, limit) {
        calls += 1;
        const remaining: Item[] = [];
        for (let id = total - 1; id >= 0; id -= 1) {
          if (cursor === null || id < cursor) remaining.push({ id });
        }
        if (remaining.length <= limit) return Promise.resolve({ data: remaining, error: null });
        const page = remaining.slice(0, limit - 1);
        page.push(remaining[remaining.length - 1]);
        return Promise.resolve({ data: page, error: null });
      },
      cursorAfter: (row) => row.id,
      cursorKey: (cursor) => String(cursor),
      pageRows: 3,
    };
    const result = await ops.readOwnerInventory<Item, number>(reader);
    const ids = result.rows.map((row) => row.id);
    if (result.status === "COMPLETE") {
      assertEquals(
        ids.length,
        total,
        JSON.stringify({
          status: result.status,
          calls,
          served: ids,
          note: "COMPLETE was reported but rows 1..7 were never read",
        }),
      );
    } else {
      assertEquals(result.reason, "malformed_page");
    }
  },
);

// ─── A3: numeric keyset precision ────────────────────────────────────────────

Deno.test(
  "W07-06 attack A3: numeric keyset values above 2^53 must not skip rows (JSON precision loss)",
  async () => {
    // Two distinct rows whose bigint ids differ only beyond 2^53. PostgREST
    // serialises them as JSON numbers; JSON.parse collapses both to
    // 9007199254740992, and postgrestKeysetAfter stringifies that. The cursor
    // after row 2^53+1 therefore reads "…992" — and the filter `id.lt."…992"`
    // excludes the real row 2^53, which is never served and never repeats.
    const truth = [BigInt("9007199254740993"), BigInt("9007199254740992")];
    type BigRow = Record<string, unknown>;
    type BigCursor = KeysetColumn[];
    const servedPages: string[] = [];
    const result = await ops.readOwnerInventory<BigRow, BigCursor>({
      readPage(cursor, limit) {
        const below = cursor === null ? null : BigInt(cursor[0].value);
        const page = truth
          .filter((id) => below === null || id < below)
          .slice(0, limit)
          .map((id) => `{"id":${id.toString()}}`);
        const body = `[${page.join(",")}]`;
        servedPages.push(body);
        return Promise.resolve({ data: JSON.parse(body) as BigRow[], error: null });
      },
      cursorAfter: (row) => ops.postgrestKeysetAfter(row, ["id"]),
      cursorKey: (cursor) => JSON.stringify(cursor.map((part) => part.value)),
      pageRows: 1,
    });
    if (result.status === "COMPLETE") {
      assertEquals(
        result.rows.length,
        truth.length,
        JSON.stringify({
          status: result.status,
          servedPages,
          note: "COMPLETE with one of two rows: 9007199254740992 was silently skipped",
        }),
      );
    } else {
      assertEquals(result.reason, "malformed_page", "a non-filterable numeric key must be refused");
    }
  },
);

// ─── A4: non-adjacent replay ─────────────────────────────────────────────────

Deno.test(
  "W07-06 attack A4: a row re-served three pages later is still INCOMPLETE (repeated_row)",
  async () => {
    const total = 12;
    const replayed = total - 1; // served on page 1
    let call = 0;
    const result = await ops.readOwnerInventory<Item, number>({
      readPage(cursor, limit) {
        call += 1;
        const start = cursor === null ? total - 1 : cursor - 1;
        const data: Item[] = [];
        for (let id = start; id >= 0 && data.length < limit; id -= 1) data.push({ id });
        if (call === 3 && data.length > 0) data[data.length - 1] = { id: replayed };
        return Promise.resolve({ data, error: null });
      },
      cursorAfter: (row) => row.id,
      cursorKey: (cursor) => String(cursor),
      pageRows: 4,
    });
    assert(result.status === "INCOMPLETE", JSON.stringify(result));
    assertEquals(result.reason, "repeated_row");
    assertEquals(result.rows.length, 8, "the page carrying the replay is not appended");
    assertEquals(call, 3);
    assertEquals(ops.completedInventoryRows(result), null);
  },
);

// ─── A5: corrupt rows inside a page ──────────────────────────────────────────

Deno.test(
  "W07-06 attack A5: null, sparse and object-keyed rows make the page INCOMPLETE (never appended)",
  async () => {
    type Loose = Record<string, unknown>;
    type LooseReader = Parameters<typeof ops.readOwnerInventory<Loose, KeysetColumn[]>>[0];
    const sparse: Loose[] = [];
    sparse[1] = { day: "2026-01-02" };
    const pages: Array<Loose[]> = [
      [{ day: "2026-01-03" }, null as unknown as Loose],
      sparse,
      [{ day: "2026-01-03" }, { day: { toString: () => "2026-01-02" } }],
      [{ day: "2026-01-03" }, { day: Number.NaN }],
      [{ day: "2026-01-03" }, { day: true }],
      [{ day: "2026-01-03" }, {}],
    ];
    for (const page of pages) {
      let calls = 0;
      const reader: LooseReader = {
        readPage() {
          calls += 1;
          return Promise.resolve({ data: page, error: null });
        },
        cursorAfter: (row) => ops.postgrestKeysetAfter(row, ["day"]),
        cursorKey: (cursor) => JSON.stringify(cursor.map((part) => part.value)),
        pageRows: 10,
      };
      const result = await ops.readOwnerInventory<Loose, KeysetColumn[]>(reader);
      assert(result.status === "INCOMPLETE", Deno.inspect({ page, result }));
      assertEquals(result.reason, "malformed_page", Deno.inspect(page));
      assertEquals(result.rows, [], "no row of a page the reader cannot describe is kept");
      assertEquals(calls, 1);
      assertEquals(ops.completedInventoryRows(result), null);
    }
  },
);

// ─── A6: network failures at the reader boundary ─────────────────────────────

Deno.test(
  "W07-06 attack A6: 429+Retry-After, 3xx, empty-body 5xx and an aborted fetch all end INCOMPLETE with the status kept",
  async () => {
    const cases: Array<{
      name: string;
      page: () => PromiseLike<InventoryPage<Item>>;
      status: number | null;
    }> = [
      {
        name: "429 rate limited",
        page: () =>
          Promise.resolve({
            data: null,
            error: { message: "rate limited", code: "PGRST" },
            status: 429,
          }),
        status: 429,
      },
      {
        name: "301 redirect served as a page",
        page: () => Promise.resolve({ data: null, error: { message: "" }, status: 301 }),
        status: 301,
      },
      {
        name: "502 with an empty body (supabase-js: error {message:''})",
        page: () => Promise.resolve({ data: null, error: { message: "" }, status: 502 }),
        status: 502,
      },
      {
        name: "aborted fetch (DOMException)",
        page: () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
        status: null,
      },
      {
        name: "non-Error rejection",
        page: () => Promise.reject("socket hang up"),
        status: null,
      },
    ];
    for (const testCase of cases) {
      let call = 0;
      const result = await ops.readOwnerInventory<Item, number>({
        readPage(cursor, limit) {
          call += 1;
          if (call === 2) return testCase.page();
          const start = cursor === null ? 9 : cursor - 1;
          const data: Item[] = [];
          for (let id = start; id >= 0 && data.length < limit; id -= 1) data.push({ id });
          return Promise.resolve({ data, error: null });
        },
        cursorAfter: (row) => row.id,
        cursorKey: (cursor) => String(cursor),
        pageRows: 4,
      });
      assert(result.status === "INCOMPLETE", testCase.name);
      assertEquals(result.reason, "page_error", testCase.name);
      assertEquals(result.httpStatus, testCase.status, testCase.name);
      assertEquals(
        result.rows.length,
        4,
        `${testCase.name}: only page 1 is exposed, as diagnostics`,
      );
      assertEquals(ops.completedInventoryRows(result), null, testCase.name);
      assertEquals(typeof result.error.message, "string", testCase.name);
    }
  },
);

// ─── Route-level attacks ─────────────────────────────────────────────────────

const ownerFilter = (url: URL): string | null => url.searchParams.get("user_id");

/** Serves `tables` per owner (the harness does not filter user_id itself), so a
 * page that dropped its owner filter would leak another owner's rows. */
function servePerOwner(
  byOwner: Record<string, Record<string, Row[]>>,
  options: StandInOptions = {},
): RecordedCall[] {
  const served: RecordedCall[] = [];
  h.respond = (call) => {
    if (call.method !== "GET") return null;
    const url = new URL(call.url);
    const table = progressTable(url);
    if (table !== "practice_days" && table !== "progress_daily") return null;
    served.push(call);
    const owner = ownerFilter(url);
    if (owner === null || !owner.startsWith("eq.")) {
      // No owner filter: PostgREST under RLS would answer with the caller's
      // rows only; a stand-in cannot know the caller, so answer with EVERY
      // owner's rows to make the leak visible.
      const all = Object.values(byOwner).flatMap((tables) => tables[table] ?? []);
      return jsonResponse(200, postgrestSelect(url, all, options));
    }
    const rows = byOwner[owner.slice(3)]?.[table] ?? [];
    return jsonResponse(200, postgrestSelect(url, rows, options));
  };
  return served;
}

const KEY_COLUMNS = new Set(["day", "shot_type", "scoring_model_version"]);

function assertOwnerScopedPages(served: RecordedCall[], ownerId: string): void {
  assert(served.length > 0);
  for (const call of served) {
    const url = new URL(call.url);
    assertEquals(
      ownerFilter(url),
      `eq.${ownerId}`,
      `every page carries the owner filter: ${call.url}`,
    );
    assertEquals(url.searchParams.get("offset"), null);
    assertEquals(url.searchParams.get("limit"), String(PAGE));
    const or = url.searchParams.get("or");
    if (or !== null) {
      // Only key columns may appear as filter identifiers in the logic tree
      // (quoted values are stripped first so hostile values cannot spoof one).
      const stripped = or.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const match of stripped.matchAll(/([a-z_][a-z0-9_]*)\.(?:lt|eq)\./g)) {
        assert(KEY_COLUMNS.has(match[1]), `unexpected filter column ${match[1]} in ${or}`);
      }
      assert(!stripped.includes("user_id"), `owner scoping must stay in the eq filter: ${or}`);
    }
  }
}

// ─── A7: concurrent owners ───────────────────────────────────────────────────

Deno.test(
  "W07-06 attack A7: two owners paging concurrently each receive exactly their own history",
  async () => {
    h.reset();
    const ownerA = "07066001-0000-4000-8000-00000000000a";
    const ownerB = "07066001-0000-4000-8000-00000000000b";
    const today = todayIndex();
    const seriesFor = (owner: string, days: number): Row[] => {
      const rows: Row[] = [];
      for (let offset = 0; offset < days; offset += 1) {
        rows.push({
          day: isoDay(today - offset),
          shot_type: `dink-${owner.slice(-1)}`,
          scoring_model_version: "sm-v1",
          shot_count: 1,
          avg_score: 5,
          best_score: 6,
        });
      }
      return rows;
    };
    const tables = {
      [ownerA]: {
        practice_days: practiceDays(2 * PAGE + 7),
        progress_daily: seriesFor(ownerA, 1_300),
      },
      [ownerB]: { practice_days: practiceDays(3), progress_daily: seriesFor(ownerB, 2) },
    };
    const served = servePerOwner(tables, { maxRows: 400 });

    const [resA, resB] = await Promise.all([
      h.handler(
        userRequest("GET", "/v1/progress", {
          token: fakeGoogleIdToken(ownerA),
          ip: "203.0.113.160",
        }),
      ),
      h.handler(
        userRequest("GET", "/v1/progress", {
          token: fakeGoogleIdToken(ownerB),
          ip: "203.0.113.161",
        }),
      ),
    ]);
    assertEquals(resA.status, 200, await resA.clone().text());
    assertEquals(resB.status, 200, await resB.clone().text());
    const bodyA = (await resA.json()) as ProgressBody;
    const bodyB = (await resB.json()) as ProgressBody;

    assertEquals(bodyA.series.length, 1_300);
    assert(
      bodyA.series.every((p) => p.shot_type === "dink-a"),
      "owner A sees only A's points",
    );
    assertEquals(bodyA.streak.currentDays, 2 * PAGE + 7);
    assertEquals(bodyB.series.length, 2);
    assert(
      bodyB.series.every((p) => p.shot_type === "dink-b"),
      "owner B sees only B's points",
    );
    assertEquals(bodyB.streak.currentDays, 3);

    const forOwner = (owner: string) =>
      served.filter((call) => ownerFilter(new URL(call.url)) === `eq.${owner}`);
    assertOwnerScopedPages(forOwner(ownerA), ownerA);
    assertOwnerScopedPages(forOwner(ownerB), ownerB);
    assertEquals(forOwner(ownerA).length + forOwner(ownerB).length, served.length);
  },
);

// ─── A8: mutation mid-read ───────────────────────────────────────────────────

Deno.test(
  "W07-06 attack A8: rows deleted and inserted between pages neither duplicate nor drop the unread rows",
  async () => {
    h.reset();
    const owner = "07066002-0000-4000-8000-000000000002";
    const today = todayIndex();
    const series: Row[] = [];
    for (let offset = 0; offset < 35; offset += 1) {
      for (const shotType of ["dink", "drive", "drop", "serve", "volley"]) {
        for (const version of ["sm-v1", "sm-v2"]) {
          series.push({
            day: isoDay(today - offset),
            shot_type: shotType,
            scoring_model_version: version,
            shot_count: 2,
            avg_score: 5.5,
            best_score: 7.25,
          });
        }
      }
    }
    const originalKeys = series.map((row) =>
      seriesKey(row as { day: string; shot_type: string; scoring_model_version: string }),
    );
    const lateSynced: Row[] = [40, 41].map((offset) => ({
      day: isoDay(today - offset),
      shot_type: "dink",
      scoring_model_version: "sm-v1",
      shot_count: 1,
      avg_score: 4,
      best_score: 4,
    }));
    let seriesPages = 0;
    h.respond = (call) => {
      if (call.method !== "GET") return null;
      const url = new URL(call.url);
      const table = progressTable(url);
      if (table === "practice_days") return jsonResponse(200, []);
      if (table !== "progress_daily") return null;
      seriesPages += 1;
      const page = postgrestSelect(url, series, { maxRows: 100 });
      if (seriesPages === 1) {
        // Between page 1 and page 2: three rows already served disappear (an
        // offset reader would now skip three unread rows) and two older rows
        // arrive (a late offline sync) inside the unread range.
        series.splice(10, 3);
        series.push(...lateSynced);
      }
      return jsonResponse(200, page);
    };

    const res = await h.handler(
      userRequest("GET", "/v1/progress", { token: fakeGoogleIdToken(owner), ip: "203.0.113.162" }),
    );
    assertEquals(res.status, 200, await res.clone().text());
    const body = (await res.json()) as ProgressBody;
    const keys = body.series.map(seriesKey);
    assertEquals(new Set(keys).size, keys.length, "no point served twice");
    for (const key of originalKeys) assert(keys.includes(key), `unread row dropped: ${key}`);
    for (const row of lateSynced) {
      assert(
        keys.includes(
          seriesKey(row as { day: string; shot_type: string; scoring_model_version: string }),
        ),
        "a row that arrived below the cursor before its page was read is included",
      );
    }
    assertEquals(keys.length, originalKeys.length + lateSynced.length);
    // 100+100+100+49 (350 − 3 + 2 = 349 rows) + the empty proof page.
    assertEquals(seriesPages, 5);
  },
);

// ─── A9: hostile key values at page boundaries ───────────────────────────────

Deno.test(
  "W07-06 attack A9: key values with quotes, backslashes, commas, parens, dots, keywords and empty strings survive every page boundary",
  async () => {
    h.reset();
    const owner = "07066003-0000-4000-8000-000000000003";
    const today = todayIndex();
    const shotTypes = ['a"b', "c\\d", "e,f", "g)h", "i(j", "k.l", "", "and", "or", 'x"\\",)'];
    const versions = ["", 'v"1', "v,2", "\\", "not.in.(1)"];
    const series: Row[] = [];
    for (let offset = 0; offset < 12; offset += 1) {
      for (const shotType of shotTypes) {
        for (const version of versions) {
          series.push({
            day: isoDay(today - offset),
            shot_type: shotType,
            scoring_model_version: version,
            shot_count: 1,
            avg_score: 5,
            best_score: 5,
          });
        }
      }
    }
    // 12 × 10 × 5 = 600 rows, 7 per page → 86 boundaries landing on every value.
    const served: RecordedCall[] = [];
    h.respond = (call) => {
      if (call.method !== "GET") return null;
      const url = new URL(call.url);
      const table = progressTable(url);
      if (table === "practice_days") return jsonResponse(200, []);
      if (table !== "progress_daily") return null;
      served.push(call);
      return jsonResponse(200, postgrestSelect(url, series, { maxRows: 7 }));
    };

    const res = await h.handler(
      userRequest("GET", "/v1/progress", { token: fakeGoogleIdToken(owner), ip: "203.0.113.163" }),
    );
    assertEquals(res.status, 200, await res.clone().text());
    const body = (await res.json()) as ProgressBody;
    const expected = new Set(
      series.map((row) =>
        seriesKey(row as { day: string; shot_type: string; scoring_model_version: string }),
      ),
    );
    const got = body.series.map(seriesKey);
    assertEquals(new Set(got).size, got.length, "no duplicates across hostile boundaries");
    assertEquals(new Set(got), expected, "every point survives");
    assertEquals(served.length, Math.ceil(600 / 7) + 1);
    assertOwnerScopedPages(served, owner);
  },
);

// ─── A10: transport failures on a keyset page ────────────────────────────────

Deno.test(
  "W07-06 attack A10: 429+Retry-After, a redirect and an HTML body on a later page are 503, never a partial 200",
  async () => {
    const failures: Array<{ name: string; response: () => Response }> = [
      {
        name: "429 with Retry-After",
        response: () => jsonResponse(429, { message: "rate limited" }, { "Retry-After": "7" }),
      },
      {
        name: "302 redirect",
        response: () =>
          new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }),
      },
      {
        name: "200 with an HTML interstitial body",
        response: () =>
          new Response("<html><body>Service temporarily unavailable</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      },
      {
        name: "502 with an empty body",
        response: () => new Response(null, { status: 502 }),
      },
    ];
    for (const [index, failure] of failures.entries()) {
      h.reset();
      const owner = `07066004-0000-4000-8000-00000000000${index}`;
      const days = practiceDays(2 * PAGE + 5);
      let dayPages = 0;
      h.respond = (call) => {
        if (call.method !== "GET") return null;
        const url = new URL(call.url);
        const table = progressTable(url);
        if (table === "progress_daily") return jsonResponse(200, []);
        if (table !== "practice_days") return null;
        dayPages += 1;
        if (dayPages === 2) return failure.response();
        return jsonResponse(200, postgrestSelect(url, days));
      };
      const { result: res, logs } = await captureConsole(() =>
        h.handler(
          userRequest("GET", "/v1/progress", {
            token: fakeGoogleIdToken(owner),
            ip: `203.0.113.${170 + index}`,
          }),
        ),
      );
      const text = await res.text();
      assertEquals(res.status, 503, `${failure.name}: ${text}`);
      assertEquals(dayPages, 2, failure.name);
      assertEquals(
        JSON.parse(text),
        { error: { message: "Progress is temporarily unavailable. Please try again." } },
        failure.name,
      );
      assert(!text.includes("INV0") && !text.includes("practice_days"), failure.name);
      const progressLog = logs.find(
        (entry) => entry.level === "error" && entry.args[0] === "[api] Progress:",
      );
      assert(progressLog, `${failure.name}: ${JSON.stringify(logs)}`);
    }
  },
);

// ─── A11: corrupt page shapes on a keyset page ───────────────────────────────

Deno.test(
  "W07-06 attack A11: an over-full page or a non-array page mid-read is 503 with the bounded reason logged",
  async () => {
    const corruptions: Array<{ name: string; body: unknown; code: string }> = [
      {
        name: "page overflow (limit+1 rows)",
        body: practiceDays(PAGE + 1),
        code: ops.INVENTORY_INCOMPLETE_CODES.page_overflow,
      },
      {
        name: "object instead of an array",
        body: { day: isoDay(todayIndex()) },
        code: ops.INVENTORY_INCOMPLETE_CODES.malformed_page,
      },
      {
        name: "row whose key is null",
        body: [{ day: null }],
        code: ops.INVENTORY_INCOMPLETE_CODES.malformed_page,
      },
    ];
    for (const [index, corruption] of corruptions.entries()) {
      h.reset();
      const owner = `07066005-0000-4000-8000-00000000000${index}`;
      const days = practiceDays(PAGE + 3);
      let dayPages = 0;
      h.respond = (call) => {
        if (call.method !== "GET") return null;
        const url = new URL(call.url);
        const table = progressTable(url);
        if (table === "progress_daily") return jsonResponse(200, []);
        if (table !== "practice_days") return null;
        dayPages += 1;
        if (dayPages === 2) return jsonResponse(200, corruption.body);
        return jsonResponse(200, postgrestSelect(url, days));
      };
      const { result: res, logs } = await captureConsole(() =>
        h.handler(
          userRequest("GET", "/v1/progress", {
            token: fakeGoogleIdToken(owner),
            ip: `203.0.113.${180 + index}`,
          }),
        ),
      );
      const text = await res.text();
      assertEquals(res.status, 503, `${corruption.name}: ${text}`);
      assertEquals(dayPages, 2, corruption.name);
      assert(!text.includes("INV0"), text);
      const progressLog = logs.find(
        (entry) => entry.level === "error" && entry.args[0] === "[api] Progress:",
      );
      assert(progressLog, `${corruption.name}: ${JSON.stringify(logs)}`);
      assertEquals(
        (progressLog.args[1] as { code: string }).code,
        corruption.code,
        corruption.name,
      );
    }
  },
);

// ─── A12: coalesced same-owner requests during a failing read ────────────────

Deno.test(
  "W07-06 attack A12: coalesced concurrent requests share one failing read — both 503, nothing cached, next read completes",
  async () => {
    h.reset();
    const owner = "07066006-0000-4000-8000-000000000006";
    const days = practiceDays(2 * PAGE + 1);
    let dayPages = 0;
    let failing = true;
    h.respond = async (call) => {
      if (call.method !== "GET") return null;
      const url = new URL(call.url);
      const table = progressTable(url);
      if (table === "progress_daily") return jsonResponse(200, []);
      if (table !== "practice_days") return null;
      dayPages += 1;
      if (failing && url.searchParams.get("or") === null) {
        // Hold page 1 so the second request reaches the single-flight before
        // the first build fails.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (failing && url.searchParams.get("or") !== null) {
        return jsonResponse(500, { code: "57014", message: "statement timeout" });
      }
      return jsonResponse(200, postgrestSelect(url, days));
    };
    const request = () =>
      h.handler(
        userRequest("GET", "/v1/progress", {
          token: fakeGoogleIdToken(owner),
          ip: "203.0.113.190",
        }),
      );
    const [first, second] = await Promise.all([request(), request()]);
    assertEquals(first.status, 503, await first.clone().text());
    assertEquals(second.status, 503, await second.clone().text());
    assertEquals(dayPages, 2, "one shared build: page 1 + the failing keyset page");

    failing = false;
    const third = await request();
    assertEquals(third.status, 200, await third.clone().text());
    const body = (await third.json()) as ProgressBody;
    assertEquals(body.streak.currentDays, 2 * PAGE + 1, "the complete history after recovery");
    assertEquals(dayPages, 2 + 4, "2 full pages + 1-row page + empty proof");

    const fourth = await request();
    assertEquals(fourth.status, 200);
    assertEquals(dayPages, 6, "the COMPLETE payload is served from cache");
  },
);
