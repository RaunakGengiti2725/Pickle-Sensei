// W07-06 — owner inventory pagination completes or reports INCOMPLETE.
//
// BASE defect: `readAllRows` in index.ts pages a PostgREST read by offset and
// stops after MAX_PAGES (20) full pages, returning whatever it has as if it were
// the whole inventory. An owner with more rows than that cap gets a silently
// truncated history (and any cleanup consumer built on the same helper would
// declare a partial inventory "done").
//
// Pinned behaviour: every unbounded owner read goes through the cursor-driven
// reader in accountDeletionOperations.ts, which either proves completion (an
// empty page after the cursor) or returns `status: "INCOMPLETE"` with a reason;
// consumers never treat an INCOMPLETE inventory as the whole set.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { fakeGoogleIdToken, loadHarness, type RecordedCall, userRequest } from "./routesHarness.ts";

// Dynamic so this file still loads on BASE_SHA (where the exports do not exist):
// the route pins below then fail on the truncation itself, not on a link error.
const ops = await import("../accountDeletionOperations.ts");

const h = await loadHarness();

const PAGE = 1_000;

// ─── A minimal PostgREST stand-in that honours keyset filters ─────────────────
//
// It applies `order`, `limit`, `offset` and the `or=(…)` logic tree PostgREST
// accepts (comparisons + nested and/or, quoted values with backslash escapes),
// and throws on any grammar it does not understand so a malformed filter string
// produced by the edge fn fails the test instead of being ignored.

type Row = Record<string, string | number>;
type Comparison = { kind: "cmp"; column: string; op: "lt" | "gt" | "eq"; value: string };
type LogicNode = Comparison | { kind: "and" | "or"; children: LogicNode[] };

class LogicParser {
  private index = 0;
  constructor(private readonly input: string) {}

  static parse(input: string): LogicNode {
    const parser = new LogicParser(input);
    const node = parser.tree();
    if (parser.index !== input.length) {
      throw new Error(`trailing input in logic tree: ${input.slice(parser.index)}`);
    }
    return node;
  }

  private tree(): LogicNode {
    const identifier = this.identifier();
    if (identifier === "and" || identifier === "or") {
      this.expect("(");
      const children: LogicNode[] = [this.tree()];
      while (this.peek() === ",") {
        this.index += 1;
        children.push(this.tree());
      }
      this.expect(")");
      return { kind: identifier, children };
    }
    this.expect(".");
    const op = this.identifier();
    if (op !== "lt" && op !== "gt" && op !== "eq") throw new Error(`unsupported operator ${op}`);
    this.expect(".");
    return { kind: "cmp", column: identifier, op, value: this.value() };
  }

  private identifier(): string {
    const match = /^[a-z_][a-z0-9_]*/.exec(this.input.slice(this.index));
    if (!match) throw new Error(`identifier expected at ${this.index} in ${this.input}`);
    this.index += match[0].length;
    return match[0];
  }

  private value(): string {
    if (this.peek() !== '"') {
      const match = /^[^,)]*/.exec(this.input.slice(this.index));
      this.index += match![0].length;
      return match![0];
    }
    this.index += 1;
    let out = "";
    for (;;) {
      const char = this.input[this.index];
      if (char === undefined) throw new Error("unterminated quoted value");
      this.index += 1;
      if (char === '"') break;
      if (char === "\\") {
        out += this.input[this.index];
        this.index += 1;
        continue;
      }
      out += char;
    }
    const next = this.peek();
    if (next !== undefined && next !== "," && next !== ")") {
      throw new Error(`quoted value must be followed by , or ) at ${this.index}`);
    }
    return out;
  }

  private peek(): string | undefined {
    return this.input[this.index];
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      throw new Error(`expected ${char} at ${this.index} in ${this.input}`);
    }
    this.index += 1;
  }
}

function matches(row: Row, node: LogicNode): boolean {
  if (node.kind === "and") return node.children.every((child) => matches(row, child));
  if (node.kind === "or") return node.children.some((child) => matches(row, child));
  const actual = String(row[node.column]);
  if (node.op === "eq") return actual === node.value;
  if (node.op === "lt") return actual < node.value;
  return actual > node.value;
}

function postgrestSelect(url: URL, table: Row[]): Row[] {
  let rows = table;
  const logic = url.searchParams.get("or");
  if (logic !== null) {
    const node = LogicParser.parse(`or${logic}`);
    rows = rows.filter((row) => matches(row, node));
  }
  const orderTerms = (url.searchParams.get("order") ?? "").split(",").filter(Boolean);
  if (orderTerms.length > 0) {
    const terms = orderTerms.map((term) => {
      const [column, direction] = term.split(".");
      if (direction !== "asc" && direction !== "desc") throw new Error(`bad order term ${term}`);
      return { column, descending: direction === "desc" };
    });
    rows = [...rows].sort((a, b) => {
      for (const term of terms) {
        const left = String(a[term.column]);
        const right = String(b[term.column]);
        if (left === right) continue;
        const cmp = left < right ? -1 : 1;
        return term.descending ? -cmp : cmp;
      }
      return 0;
    });
  }
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = url.searchParams.get("limit");
  return rows.slice(offset, limit === null ? undefined : offset + Number(limit));
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isoDay = (dayIndex: number): string =>
  new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);

/** `total` consecutive practice days ending today (newest-first inventory). */
function practiceDays(total: number): Row[] {
  const today = Math.floor(Date.now() / 86_400_000);
  const rows: Row[] = [];
  for (let offset = 0; offset < total; offset += 1) rows.push({ day: isoDay(today - offset) });
  return rows;
}

function progressTable(url: URL): string {
  return url.pathname.slice("/rest/v1/".length);
}

function serveProgressTables(tables: Record<string, Row[]>): RecordedCall[] {
  const served: RecordedCall[] = [];
  h.respond = (call) => {
    if (call.method !== "GET") return null;
    const url = new URL(call.url);
    const table = progressTable(url);
    if (!(table in tables)) return null;
    served.push(call);
    return jsonResponse(200, postgrestSelect(url, tables[table]));
  };
  return served;
}

// ─── Unit pins: the cursor reader ────────────────────────────────────────────

interface Item {
  id: number;
}

/** A well-behaved source: `total` rows ordered by id ascending, keyset paged. */
function honestSource(total: number) {
  const calls: Array<{ cursor: number | null; limit: number }> = [];
  const reader = {
    readPage(cursor: number | null, limit: number) {
      calls.push({ cursor, limit });
      const start = cursor === null ? 0 : cursor + 1;
      const data: Item[] = [];
      for (let id = start; id < Math.min(total, start + limit); id += 1) data.push({ id });
      return Promise.resolve({ data, error: null });
    },
    cursorAfter: (row: Item) => row.id,
    cursorKey: (cursor: number) => String(cursor),
  };
  return { reader, calls };
}

Deno.test("W07-06 reader: 17+ full pages are read to completion (no page cap)", async () => {
  for (const total of [17 * PAGE + 3, 21 * PAGE + 3]) {
    const { reader, calls } = honestSource(total);
    const result = await ops.readOwnerInventory<Item, number>(reader);
    assertEquals(result.status, "COMPLETE", JSON.stringify({ total, status: result.status }));
    assertEquals(result.rows.length, total);
    assertEquals(new Set(result.rows.map((row) => row.id)).size, total, "no duplicates");
    assertEquals(result.rows[total - 1].id, total - 1, "oldest row retained");
    // ceil(total / PAGE) data pages + the empty page that proves completion.
    assertEquals(result.pages, Math.ceil(total / PAGE) + 1);
    assertEquals(calls.length, result.pages);
    assertEquals(calls[0].cursor, null);
    assertEquals(calls[1].cursor, PAGE - 1, "second page starts after the first page's last row");
    for (const call of calls) assertEquals(call.limit, PAGE);
  }
});

Deno.test("W07-06 reader: an empty inventory is COMPLETE after one page", async () => {
  const { reader, calls } = honestSource(0);
  const result = await ops.readOwnerInventory<Item, number>(reader);
  assertEquals(result.status, "COMPLETE");
  assertEquals(result.rows, []);
  assertEquals(result.pages, 1);
  assertEquals(calls.length, 1);
});

Deno.test(
  "W07-06 reader: a short page is not proof — completion needs the empty page",
  async () => {
    // A server clamping pages below the requested size (PostgREST max_rows) must
    // not be mistaken for the end of the inventory.
    const total = 2_500;
    let pages = 0;
    const result = await ops.readOwnerInventory<Item, number>({
      readPage(cursor, _limit) {
        pages += 1;
        const start = cursor === null ? 0 : cursor + 1;
        const data: Item[] = [];
        for (let id = start; id < Math.min(total, start + 400); id += 1) data.push({ id });
        return Promise.resolve({ data, error: null });
      },
      cursorAfter: (row) => row.id,
      cursorKey: (cursor) => String(cursor),
    });
    assertEquals(result.status, "COMPLETE");
    assertEquals(result.rows.length, total);
    assertEquals(pages, Math.ceil(total / 400) + 1);
  },
);

Deno.test(
  "W07-06 reader: a source that ignores the cursor is INCOMPLETE, never an infinite loop",
  async () => {
    let pages = 0;
    const page: Item[] = Array.from({ length: PAGE }, (_, id) => ({ id }));
    const result = await ops.readOwnerInventory<Item, number>({
      readPage() {
        pages += 1;
        return Promise.resolve({ data: page, error: null });
      },
      cursorAfter: (row) => row.id,
      cursorKey: (cursor) => String(cursor),
    });
    assertEquals(result.status, "INCOMPLETE");
    assert(result.status === "INCOMPLETE");
    assertEquals(result.reason, "cursor_stalled");
    assertEquals(result.rows.length, PAGE, "only the rows read before the stall are reported");
    assertEquals(pages, 2);
    assertEquals(result.error, { message: "cursor_stalled" });
    assertEquals(result.httpStatus, null);
  },
);

Deno.test("W07-06 reader: a failing page is INCOMPLETE with the page error preserved", async () => {
  const total = 5 * PAGE;
  let pages = 0;
  const result = await ops.readOwnerInventory<Item, number>({
    readPage(cursor, limit) {
      pages += 1;
      if (pages === 3) {
        return Promise.resolve({
          data: null,
          error: { message: "canceling statement due to statement timeout", code: "57014" },
          status: 500,
        });
      }
      const start = cursor === null ? 0 : cursor + 1;
      const data: Item[] = [];
      for (let id = start; id < Math.min(total, start + limit); id += 1) data.push({ id });
      return Promise.resolve({ data, error: null });
    },
    cursorAfter: (row) => row.id,
    cursorKey: (cursor) => String(cursor),
  });
  assert(result.status === "INCOMPLETE");
  assertEquals(result.reason, "page_error");
  assertEquals(result.error.code, "57014");
  assertEquals(result.httpStatus, 500);
  assertEquals(result.rows.length, 2 * PAGE);
  assertEquals(result.pages, 3);
  assertEquals(pages, 3, "reading stops at the failed page");
});

Deno.test("W07-06 reader: a page larger than requested is INCOMPLETE (limit ignored)", async () => {
  const result = await ops.readOwnerInventory<Item, number>({
    readPage(_cursor, limit) {
      return Promise.resolve({
        data: Array.from({ length: limit + 1 }, (_, id) => ({ id })),
        error: null,
      });
    },
    cursorAfter: (row) => row.id,
    cursorKey: (cursor) => String(cursor),
  });
  assert(result.status === "INCOMPLETE");
  assertEquals(result.reason, "page_overflow");
  assertEquals(result.rows, []);
});

Deno.test("W07-06 reader: cleanup consumers get rows only from a COMPLETE inventory", async () => {
  const { reader } = honestSource(3);
  const complete = await ops.readOwnerInventory<Item, number>(reader);
  assertEquals(ops.completedInventoryRows(complete), [{ id: 0 }, { id: 1 }, { id: 2 }]);

  const stalled = await ops.readOwnerInventory<Item, number>({
    readPage: () =>
      Promise.resolve({
        data: Array.from({ length: PAGE }, (_, id) => ({ id })),
        error: null,
      }),
    cursorAfter: (row) => row.id,
    cursorKey: (cursor) => String(cursor),
  });
  assertEquals(stalled.status, "INCOMPLETE");
  assertEquals(stalled.rows.length, PAGE, "partial rows are visible for diagnostics …");
  assertEquals(ops.completedInventoryRows(stalled), null, "… but never handed out as the set");
});

Deno.test(
  "W07-06 keyset filter: PostgREST `or` tree for rows strictly before a descending key",
  () => {
    assertEquals(
      ops.postgrestKeysetBefore([{ column: "day", value: "2026-09-08" }]),
      'day.lt."2026-09-08"',
    );
    assertEquals(
      ops.postgrestKeysetBefore([
        { column: "day", value: "2026-09-08" },
        { column: "shot_type", value: "dink" },
        { column: "scoring_model_version", value: "sm-v1" },
      ]),
      'day.lt."2026-09-08",and(day.eq."2026-09-08",or(shot_type.lt."dink",and(shot_type.eq."dink",scoring_model_version.lt."sm-v1")))',
    );
    // Reserved characters and quotes are escaped the way PostgREST unescapes them.
    assertEquals(
      ops.postgrestKeysetBefore([{ column: "name", value: 'a,b.c)"d\\e' }]),
      'name.lt."a,b.c)\\"d\\\\e"',
    );
    assertEquals(
      LogicParser.parse(
        `or(${ops.postgrestKeysetBefore([{ column: "name", value: 'a,b.c)"d\\e' }])})`,
      ),
      {
        kind: "or",
        children: [{ kind: "cmp", column: "name", op: "lt", value: 'a,b.c)"d\\e' }],
      },
    );
    assertThrows(() => ops.postgrestKeysetBefore([]));
    assertThrows(() => ops.postgrestKeysetBefore([{ column: "day.desc", value: "x" }]));
    assertThrows(() => ops.postgrestKeysetBefore([{ column: "Day", value: "x" }]));
  },
);

// ─── Route pins: GET /v1/progress is the shipping consumer ───────────────────

Deno.test(
  "W07-06 route: practice_days inventory of 21 full pages + 3 is served completely",
  async () => {
    h.reset();
    const ip = "203.0.113.240";
    const auth = { token: fakeGoogleIdToken("07060001-0000-4000-8000-000000000001") };
    const total = 21 * PAGE + 3;
    const days = practiceDays(total);
    const served = serveProgressTables({ practice_days: days, progress_daily: [] });

    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      streak: { practicedToday: boolean; currentDays: number; lastPracticeDate: string | null };
    };
    assertEquals(body.streak.practicedToday, true, JSON.stringify(body.streak));
    assertEquals(body.streak.lastPracticeDate, days[0].day);
    assertEquals(body.streak.currentDays, total, "every practice day counts — nothing truncated");

    const requests = served.filter((call) => progressTable(new URL(call.url)) === "practice_days");
    assertEquals(
      requests.length,
      Math.ceil(total / PAGE) + 1,
      "22 data pages + the empty proof page",
    );
    for (const [index, call] of requests.entries()) {
      const url = new URL(call.url);
      assertEquals(url.searchParams.get("order"), "day.desc");
      assertEquals(url.searchParams.get("limit"), String(PAGE));
      assertEquals(url.searchParams.get("offset"), null, "cursor-driven: no offset paging");
      if (index === 0) assertEquals(url.searchParams.get("or"), null);
      else {
        const lastServed = days[Math.min(index * PAGE, total) - 1];
        assertEquals(url.searchParams.get("or"), `(day.lt."${lastServed.day}")`);
      }
    }
  },
);

Deno.test(
  "W07-06 route: progress_daily inventory of 17+ pages keeps every series point",
  async () => {
    h.reset();
    const ip = "203.0.113.241";
    const auth = { token: fakeGoogleIdToken("07060002-0000-4000-8000-000000000002") };
    const shotTypes = ["dink", "drive", "drop", "serve", "volley"];
    const versions = ["sm-v1", "sm-v2"];
    const dayCount = 2_100; // 2_100 × 5 × 2 = 21_000 rows → 21 full pages
    const today = Math.floor(Date.now() / 86_400_000);
    const series: Row[] = [];
    for (let offset = 0; offset < dayCount; offset += 1) {
      for (const shotType of shotTypes) {
        for (const version of versions) {
          series.push({
            day: isoDay(today - offset),
            shot_type: shotType,
            scoring_model_version: version,
            shot_count: 1 + (offset % 3),
            avg_score: 5.5,
            best_score: 7.25,
          });
        }
      }
    }
    const served = serveProgressTables({ practice_days: [], progress_daily: series });

    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      series: Array<{ day: string; shot_type: string; scoring_model_version: string }>;
    };
    assertEquals(
      body.series.length,
      series.length,
      "every day × shot type × version point survives",
    );
    assertEquals(
      new Set(body.series.map((p) => `${p.day}|${p.shot_type}|${p.scoring_model_version}`)).size,
      series.length,
      "no duplicated points across page boundaries",
    );
    assertEquals(body.series[0].day, isoDay(today - (dayCount - 1)), "oldest point first");
    assertEquals(body.series[body.series.length - 1].day, isoDay(today), "today last");

    const requests = served.filter((call) => progressTable(new URL(call.url)) === "progress_daily");
    assertEquals(requests.length, Math.ceil(series.length / PAGE) + 1);
    for (const call of requests.slice(1)) {
      const url = new URL(call.url);
      assertEquals(url.searchParams.get("offset"), null);
      assert(
        (url.searchParams.get("or") ?? "").startsWith('(day.lt."'),
        url.searchParams.get("or") ?? "",
      );
    }
  },
);

Deno.test(
  "W07-06 route: a source that keeps returning the same page yields 503, not a fabricated history",
  async () => {
    h.reset();
    const ip = "203.0.113.242";
    const auth = { token: fakeGoogleIdToken("07060003-0000-4000-8000-000000000003") };
    const firstPage = practiceDays(PAGE);
    let requests = 0;
    h.respond = (call) => {
      if (call.method !== "GET") return null;
      const url = new URL(call.url);
      const table = progressTable(url);
      if (table === "progress_daily") return jsonResponse(200, []);
      if (table !== "practice_days") return null;
      requests += 1;
      // Ignores order, limit, offset and cursor alike: always the same full page.
      return jsonResponse(200, firstPage);
    };

    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 503, await res.text());
    assertEquals(requests, 2, "the stall is detected on the second page");
  },
);

Deno.test(
  "W07-06 route: a page error part-way through is 503 (never a partial history as 200)",
  async () => {
    h.reset();
    const ip = "203.0.113.243";
    const auth = { token: fakeGoogleIdToken("07060004-0000-4000-8000-000000000004") };
    const days = practiceDays(3 * PAGE);
    let requests = 0;
    h.respond = (call) => {
      if (call.method !== "GET") return null;
      const url = new URL(call.url);
      const table = progressTable(url);
      if (table === "progress_daily") return jsonResponse(200, []);
      if (table !== "practice_days") return null;
      requests += 1;
      if (requests === 3) {
        return jsonResponse(500, {
          code: "57014",
          message: "canceling statement due to statement timeout",
        });
      }
      return jsonResponse(200, postgrestSelect(url, days));
    };

    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 503);
    assertEquals(requests, 3);
  },
);
