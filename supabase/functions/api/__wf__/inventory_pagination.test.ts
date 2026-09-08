// W07-06 — owner inventory pagination completes or reports INCOMPLETE.
//
// BASE defect: `readAllRows` in index.ts pages a PostgREST read by offset and
// stops after MAX_PAGES (20) full pages, returning whatever it has as if it were
// the whole inventory. An owner with more rows than that cap gets a silently
// truncated history (and any cleanup consumer built on the same helper would
// declare a partial inventory "done"). Its "a short page is the end" stop rule
// has a second hole: PostgREST clamps every page to min(limit, db-max-rows) and
// answers 200, so when the server's max_rows is below the requested page size
// every page is short and the very first one looks like the end.
//
// Pinned behaviour: every unbounded owner read goes through the cursor-driven
// reader in accountDeletionOperations.ts, which proves completion ONLY by an
// EMPTY page after the last cursor (a short non-empty page is never proof) or
// returns `status: "INCOMPLETE"` with a reason; consumers never treat an
// INCOMPLETE inventory as the whole set.

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
// clamps `limit` to a configurable `maxRows` exactly like PostgREST's
// db-max-rows does (silently, with HTTP 200), and throws on any grammar it does
// not understand so a malformed filter string produced by the edge fn fails the
// test instead of being ignored.

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

interface StandInOptions {
  /** PostgREST `db-max-rows`: every page is clamped to it, silently, with 200. */
  maxRows?: number;
}

function postgrestSelect(url: URL, table: Row[], options: StandInOptions = {}): Row[] {
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
  const limitParam = url.searchParams.get("limit");
  const requested = limitParam === null ? Number.POSITIVE_INFINITY : Number(limitParam);
  const limit = Math.min(requested, options.maxRows ?? Number.POSITIVE_INFINITY);
  return rows.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isoDay = (dayIndex: number): string =>
  new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);

const todayIndex = (): number => Math.floor(Date.now() / 86_400_000);

/** `total` consecutive practice days ending today (newest-first inventory). */
function practiceDays(total: number): Row[] {
  const today = todayIndex();
  const rows: Row[] = [];
  for (let offset = 0; offset < total; offset += 1) rows.push({ day: isoDay(today - offset) });
  return rows;
}

const SHOT_TYPES = ["dink", "drive", "drop", "serve", "volley"];
const MODEL_VERSIONS = ["sm-v1", "sm-v2"];

/** `dayCount` days × 5 shot types × 2 model versions of progress_daily rows. */
function progressSeries(dayCount: number): Row[] {
  const today = todayIndex();
  const series: Row[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    for (const shotType of SHOT_TYPES) {
      for (const version of MODEL_VERSIONS) {
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
  return series;
}

function progressTable(url: URL): string {
  return url.pathname.slice("/rest/v1/".length);
}

function serveProgressTables(
  tables: Record<string, Row[]>,
  options: StandInOptions = {},
): RecordedCall[] {
  const served: RecordedCall[] = [];
  h.respond = (call) => {
    if (call.method !== "GET") return null;
    const url = new URL(call.url);
    const table = progressTable(url);
    if (!(table in tables)) return null;
    served.push(call);
    return jsonResponse(200, postgrestSelect(url, tables[table], options));
  };
  return served;
}

const seriesKey = (p: { day: string; shot_type: string; scoring_model_version: string }) =>
  `${p.day}|${p.shot_type}|${p.scoring_model_version}`;

interface ProgressBody {
  series: Array<{ day: string; shot_type: string; scoring_model_version: string }>;
  streak: { practicedToday: boolean; currentDays: number; lastPracticeDate: string | null };
}

// ─── Unit pins: the cursor reader ────────────────────────────────────────────

interface Item {
  id: number;
}

type ItemReader = Parameters<typeof ops.readOwnerInventory<Item, number>>[0];

/** A well-behaved source: `total` rows ordered by id ascending, keyset paged.
 * `maxRows` clamps every page the way PostgREST's db-max-rows does. */
function honestSource(total: number, options: { maxRows?: number; pageRows?: number } = {}) {
  const calls: Array<{ cursor: number | null; limit: number }> = [];
  const reader: ItemReader = {
    readPage(cursor: number | null, limit: number) {
      calls.push({ cursor, limit });
      const effective = Math.min(limit, options.maxRows ?? Number.POSITIVE_INFINITY);
      const start = cursor === null ? 0 : cursor + 1;
      const data: Item[] = [];
      for (let id = start; id < Math.min(total, start + effective); id += 1) data.push({ id });
      return Promise.resolve({ data, error: null });
    },
    cursorAfter: (row: Item) => row.id,
    cursorKey: (cursor: number) => String(cursor),
    ...(options.pageRows === undefined ? {} : { pageRows: options.pageRows }),
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
    // The trailing 3-row page proves nothing by itself: one more (empty) page does.
    assertEquals(result.pages, Math.ceil(total / PAGE) + 1);
    assertEquals(calls.length, result.pages);
    assertEquals(calls[0].cursor, null);
    assertEquals(calls[1].cursor, PAGE - 1, "second page starts after the first page's last row");
    assertEquals(calls[calls.length - 1].cursor, total - 1, "the proof page starts after the end");
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
  "W07-06 reader: an inventory that is an exact multiple of the page needs the empty page as proof",
  async () => {
    // 17 full pages carry no evidence of the end on their own: the reader must
    // ask once more and see the empty page rather than stop on a full one.
    const total = 17 * PAGE;
    const { reader, calls } = honestSource(total);
    const result = await ops.readOwnerInventory<Item, number>(reader);
    assertEquals(result.status, "COMPLETE");
    assertEquals(result.rows.length, total);
    assertEquals(result.pages, 17 + 1);
    assertEquals(calls.length, 18);
    assertEquals(calls[17].cursor, total - 1, "the proof page starts after the last row");
  },
);

Deno.test(
  "W07-06 reader: a server that clamps pages below the requested size (db-max-rows) is read completely",
  async () => {
    // PostgREST answers 200 with min(limit, max_rows) rows on EVERY page. With
    // max_rows=500 and a 1000-row request, page 1 is "short" — and is not the end.
    for (const [total, maxRows] of [
      [1_200, 500],
      [1_001, 500],
      [2_000, 500],
      [1_500, 999],
    ]) {
      const { reader, calls } = honestSource(total, { maxRows });
      const result = await ops.readOwnerInventory<Item, number>(reader);
      assertEquals(
        result.status,
        "COMPLETE",
        JSON.stringify({ total, maxRows, status: result.status, rows: result.rows.length }),
      );
      assertEquals(result.rows.length, total, `every one of ${total} rows survives the clamp`);
      assertEquals(new Set(result.rows.map((row) => row.id)).size, total, "no duplicates");
      assertEquals(result.pages, Math.ceil(total / maxRows) + 1, "clamped pages + the proof");
      assertEquals(calls.length, result.pages);
      for (const call of calls) assertEquals(call.limit, PAGE, "the fn still asks for its page");
    }
  },
);

Deno.test(
  "W07-06 reader: a short non-empty page is never proof of the end — only an empty page is",
  async () => {
    // One row per page (an extreme clamp): 5 rows take 5 pages plus the proof.
    const { reader, calls } = honestSource(5, { maxRows: 1 });
    const result = await ops.readOwnerInventory<Item, number>(reader);
    assertEquals(result.status, "COMPLETE");
    assertEquals(
      result.rows.map((row) => row.id),
      [0, 1, 2, 3, 4],
    );
    assertEquals(result.pages, 6);
    assertEquals(
      calls.map((call) => call.cursor),
      [null, 0, 1, 2, 3, 4],
      "every non-empty page is followed by a read after its last row",
    );
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
    assertEquals(result.reason, "repeated_row");
    assertEquals(result.rows.length, PAGE, "only the rows read before the repeat are reported");
    assertEquals(pages, 2);
    assertEquals(result.error, { message: "repeated_row" });
    assertEquals(result.httpStatus, null);
  },
);

Deno.test(
  "W07-06 reader: overlapping pages (rows at or before the cursor re-served) are INCOMPLETE",
  async () => {
    // Page 1: 0..9, page 2: 5..14 — every cursor is distinct, yet rows repeat.
    const pages: Item[][] = [
      Array.from({ length: 10 }, (_, id) => ({ id })),
      Array.from({ length: 10 }, (_, i) => ({ id: 5 + i })),
      Array.from({ length: 3 }, (_, i) => ({ id: 15 + i })),
      [],
    ];
    let call = 0;
    const result = await ops.readOwnerInventory<Item, number>({
      readPage: () => Promise.resolve({ data: pages[call++] ?? [], error: null }),
      cursorAfter: (row) => row.id,
      cursorKey: (cursor) => String(cursor),
      pageRows: 10,
    });
    assert(result.status === "INCOMPLETE");
    assertEquals(result.reason, "repeated_row");
    assertEquals(result.rows.length, 10, "the overlapping page is not appended");
    assertEquals(call, 2);
  },
);

Deno.test("W07-06 reader: a page that repeats a row inside itself is INCOMPLETE", async () => {
  const page: Item[] = [{ id: 0 }, { id: 1 }, { id: 1 }, { id: 2 }];
  const result = await ops.readOwnerInventory<Item, number>({
    readPage: () => Promise.resolve({ data: page, error: null }),
    cursorAfter: (row) => row.id,
    cursorKey: (cursor) => String(cursor),
    pageRows: 10,
  });
  assert(result.status === "INCOMPLETE");
  assertEquals(result.reason, "repeated_row");
  assertEquals(result.rows, []);
});

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

Deno.test("W07-06 reader: a 429 page keeps its status so the caller can back off", async () => {
  const { reader } = honestSource(3 * PAGE);
  let pages = 0;
  const result = await ops.readOwnerInventory<Item, number>({
    ...reader,
    readPage(cursor, limit) {
      pages += 1;
      if (pages === 2) {
        return Promise.resolve({
          data: null,
          error: { message: "Too Many Requests" },
          status: 429,
        });
      }
      return reader.readPage(cursor, limit);
    },
  });
  assert(result.status === "INCOMPLETE");
  assertEquals(result.reason, "page_error");
  assertEquals(result.httpStatus, 429);
  assertEquals(ops.completedInventoryRows(result), null);
});

Deno.test("W07-06 reader: a readPage that throws is INCOMPLETE, not a rejection", async () => {
  const { reader } = honestSource(3 * PAGE);
  let pages = 0;
  const result = await ops.readOwnerInventory<Item, number>({
    ...reader,
    readPage(cursor, limit) {
      pages += 1;
      if (pages === 2) throw new TypeError("fetch failed: connection reset");
      return reader.readPage(cursor, limit);
    },
  });
  assert(result.status === "INCOMPLETE");
  assertEquals(result.reason, "page_error");
  assertEquals(result.error.message, "fetch failed: connection reset");
  assertEquals(result.httpStatus, null);
  assertEquals(result.rows.length, PAGE);
  assertEquals(result.pages, 2);
});

Deno.test("W07-06 reader: a cursorAfter that throws mid-read is INCOMPLETE", async () => {
  const { reader } = honestSource(30, { pageRows: 10 });
  let derivations = 0;
  const result = await ops.readOwnerInventory<Item, number>({
    ...reader,
    cursorAfter: (row) => {
      derivations += 1;
      if (derivations === 15) throw new Error("invalid keyset column: Day");
      return row.id;
    },
  });
  assert(result.status === "INCOMPLETE");
  assertEquals(result.reason, "malformed_page");
  assertEquals(result.error.message, "invalid keyset column: Day");
  assertEquals(result.rows.length, 10, "the page holding the bad row is not appended");
});

Deno.test("W07-06 reader: a page with no rows and no error is INCOMPLETE", async () => {
  const { reader } = honestSource(3 * PAGE);
  let pages = 0;
  const result = await ops.readOwnerInventory<Item, number>({
    ...reader,
    readPage(cursor, limit) {
      pages += 1;
      if (pages === 2) return Promise.resolve({ data: null, error: null });
      return reader.readPage(cursor, limit);
    },
  });
  assert(result.status === "INCOMPLETE");
  assertEquals(result.reason, "malformed_page");
  assertEquals(result.rows.length, PAGE);
  assertEquals(result.pages, 2);
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

Deno.test(
  "W07-06 reader: a degenerate page size is INCOMPLETE before any page is read",
  async () => {
    for (const pageRows of [0, -1, Number.NaN, 2.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const { reader, calls } = honestSource(50, { pageRows });
      const result = await ops.readOwnerInventory<Item, number>(reader);
      assert(result.status === "INCOMPLETE", `pageRows=${pageRows} → ${result.status}`);
      assertEquals(result.reason, "invalid_page_size");
      assertEquals(result.rows, []);
      assertEquals(result.pages, 0);
      assertEquals(calls.length, 0, `pageRows=${pageRows} reached the source`);
    }
  },
);

Deno.test(
  "W07-06 reader: a runaway source (fresh full page every call) is INCOMPLETE at the page budget",
  async () => {
    assert(Number.isSafeInteger(ops.INVENTORY_MAX_PAGES) && ops.INVENTORY_MAX_PAGES >= 100);
    let calls = 0;
    const result = await ops.readOwnerInventory<Item, number>({
      readPage(_cursor, limit) {
        calls += 1;
        const base = calls * limit;
        return Promise.resolve({
          data: Array.from({ length: limit }, (_, i) => ({ id: base + i })),
          error: null,
        });
      },
      cursorAfter: (row) => row.id,
      cursorKey: (cursor) => String(cursor),
      pageRows: 4,
    });
    assert(result.status === "INCOMPLETE");
    assertEquals(result.reason, "page_budget");
    assertEquals(calls, ops.INVENTORY_MAX_PAGES);
    assertEquals(result.pages, ops.INVENTORY_MAX_PAGES);
    assertEquals(result.rows.length, 4 * ops.INVENTORY_MAX_PAGES);
  },
);

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

Deno.test("W07-06 reader: the shipping page size is PostgREST's hosted max_rows", () => {
  assertEquals(ops.INVENTORY_PAGE_ROWS, 1_000);
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
    const body = (await res.json()) as ProgressBody;
    assertEquals(body.streak.practicedToday, true, JSON.stringify(body.streak));
    assertEquals(body.streak.lastPracticeDate, days[0].day);
    assertEquals(body.streak.currentDays, total, "every practice day counts — nothing truncated");

    const requests = served.filter((call) => progressTable(new URL(call.url)) === "practice_days");
    // 21 full pages + the 3-row page + the empty page that proves the end.
    assertEquals(requests.length, Math.ceil(total / PAGE) + 1);
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
    const dayCount = 2_100; // 2_100 × 5 × 2 = 21_000 rows → 21 full pages
    const series = progressSeries(dayCount);
    const served = serveProgressTables({ practice_days: [], progress_daily: series });

    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as ProgressBody;
    assertEquals(
      body.series.length,
      series.length,
      "every day × shot type × version point survives",
    );
    assertEquals(
      new Set(body.series.map(seriesKey)).size,
      series.length,
      "no duplicated points across page boundaries",
    );
    const today = todayIndex();
    assertEquals(body.series[0].day, isoDay(today - (dayCount - 1)), "oldest point first");
    assertEquals(body.series[body.series.length - 1].day, isoDay(today), "today last");

    const requests = served.filter((call) => progressTable(new URL(call.url)) === "progress_daily");
    // 21 full pages + the empty page that proves the exact multiple is complete.
    assertEquals(requests.length, series.length / PAGE + 1);
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
  "W07-06 route: PostgREST max_rows below the fn's page (500 < 1000) still yields the full history",
  async () => {
    // The prior-round P1: every page answers 200 with 500 rows, so a "short
    // page means done" reader returned page 1 as the whole history. Either the
    // full inventory or a 503 is acceptable; a 200 with less is not.
    h.reset();
    const ip = "203.0.113.244";
    const auth = { token: fakeGoogleIdToken("07060005-0000-4000-8000-000000000005") };
    const series = progressSeries(120); // 1_200 points
    const days = practiceDays(1_001);
    const served = serveProgressTables(
      { practice_days: days, progress_daily: series },
      { maxRows: 500 },
    );

    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 200, await res.clone().text());
    const body = (await res.json()) as ProgressBody;
    assertEquals(body.series.length, 1_200, "all 1200 points, not the first clamped page");
    assertEquals(new Set(body.series.map(seriesKey)).size, 1_200, "no duplicated points");
    assertEquals(body.streak.currentDays, 1_001, "all 1001 practice days, not 500");
    assertEquals(body.streak.lastPracticeDate, days[0].day);

    const seriesRequests = served.filter(
      (call) => progressTable(new URL(call.url)) === "progress_daily",
    );
    const dayRequests = served.filter(
      (call) => progressTable(new URL(call.url)) === "practice_days",
    );
    // 500 + 500 + 200 + empty proof; 500 + 500 + 1 + empty proof.
    assertEquals(seriesRequests.length, 4);
    assertEquals(dayRequests.length, 4);
    for (const call of [...seriesRequests, ...dayRequests]) {
      assertEquals(new URL(call.url).searchParams.get("limit"), String(PAGE));
    }
  },
);

Deno.test(
  "W07-06 route: max_rows one below the page (999 < 1000) is not mistaken for the end either",
  async () => {
    h.reset();
    const ip = "203.0.113.245";
    const auth = { token: fakeGoogleIdToken("07060006-0000-4000-8000-000000000006") };
    const series = progressSeries(150); // 1_500 points
    serveProgressTables({ practice_days: [], progress_daily: series }, { maxRows: 999 });

    const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(res.status, 200, await res.clone().text());
    const body = (await res.json()) as ProgressBody;
    assertEquals(body.series.length, 1_500);
    assertEquals(new Set(body.series.map(seriesKey)).size, 1_500);
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
    assertEquals(requests, 2, "the repeat is detected on the second page");
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

Deno.test(
  "W07-06 route: an INCOMPLETE read is not cached — the next request re-reads and completes",
  async () => {
    h.reset();
    const ip = "203.0.113.246";
    const auth = { token: fakeGoogleIdToken("07060007-0000-4000-8000-000000000007") };
    const days = practiceDays(2 * PAGE + 1);
    let failOnce = true;
    h.respond = (call) => {
      if (call.method !== "GET") return null;
      const url = new URL(call.url);
      const table = progressTable(url);
      if (table === "progress_daily") return jsonResponse(200, []);
      if (table !== "practice_days") return null;
      if (failOnce && url.searchParams.get("or") !== null) {
        failOnce = false;
        return jsonResponse(503, { code: "PGRST001", message: "connection unavailable" });
      }
      return jsonResponse(200, postgrestSelect(url, days));
    };

    const first = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(first.status, 503, await first.text());

    const second = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
    assertEquals(second.status, 200, await second.clone().text());
    const body = (await second.json()) as ProgressBody;
    assertEquals(body.streak.currentDays, 2 * PAGE + 1, "the complete history, not the partial");
  },
);
