// W07-06 adversarial tests — GET /v1/progress through the REAL edge handler.
//
// The shipping consumer of the cursor reader is buildProgress (index.ts). These
// attacks drive it with PostgREST stand-ins that misbehave at the boundaries the
// candidate's own route tests do not reach: a PostgREST `max-rows` clamp below
// the 1 000-row page the fn asks for, network failures (fetch rejection, 429 +
// Retry-After, 5xx, redirect) on a page AFTER the first, a corrupt row on a
// page boundary, and two owners' reads interleaved.
//
// Every test states what the route OUGHT to do; a failing test is a confirmed
// break (see the attack report), a passing one is an attack that held.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fakeGoogleIdToken, loadHarness, type RecordedCall, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const PAGE = 1_000;

type Row = Record<string, string | number | null>;

// ─── PostgREST stand-in (keyset filter + order + limit + optional max-rows) ───

type Comparison = { kind: "cmp"; column: string; op: "lt" | "gt" | "eq"; value: string };
type LogicNode =
  Comparison | { kind: "and"; children: LogicNode[] } | { kind: "or"; children: LogicNode[] };

function parseLogic(input: string): LogicNode {
  let index = 0;
  const peek = () => input[index];
  const expect = (char: string) => {
    if (peek() !== char) throw new Error(`expected ${char} at ${index} in ${input}`);
    index += 1;
  };
  const identifier = () => {
    const match = /^[a-z_][a-z0-9_]*/.exec(input.slice(index));
    if (!match) throw new Error(`identifier expected at ${index} in ${input}`);
    index += match[0].length;
    return match[0];
  };
  const value = () => {
    if (peek() !== '"') {
      const match = /^[^,)]*/.exec(input.slice(index))!;
      index += match[0].length;
      return match[0];
    }
    index += 1;
    let out = "";
    for (;;) {
      const char = input[index];
      if (char === undefined) throw new Error("unterminated quoted value");
      index += 1;
      if (char === '"') break;
      if (char === "\\") {
        out += input[index];
        index += 1;
        continue;
      }
      out += char;
    }
    return out;
  };
  const tree = (): LogicNode => {
    const name = identifier();
    if (name === "and" || name === "or") {
      expect("(");
      const children: LogicNode[] = [tree()];
      while (peek() === ",") {
        index += 1;
        children.push(tree());
      }
      expect(")");
      return { kind: name, children };
    }
    expect(".");
    const op = identifier();
    if (op !== "lt" && op !== "gt" && op !== "eq") throw new Error(`unsupported operator ${op}`);
    expect(".");
    return { kind: "cmp", column: name, op, value: value() };
  };
  const node = tree();
  if (index !== input.length) throw new Error(`trailing input: ${input.slice(index)}`);
  return node;
}

function matches(row: Row, node: LogicNode): boolean {
  if (node.kind === "and") return node.children.every((child) => matches(row, child));
  if (node.kind === "or") return node.children.some((child) => matches(row, child));
  const actual = row[node.column];
  // PostgREST rejects a filter literal the column type cannot parse (400).
  if (node.column === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(node.value)) {
    throw new PostgrestError(400, "22007", `invalid input syntax for type date: "${node.value}"`);
  }
  if (actual === null) return false;
  const text = String(actual);
  if (node.op === "eq") return text === node.value;
  if (node.op === "lt") return text < node.value;
  return text > node.value;
}

class PostgrestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function postgrestSelect(url: URL, table: Row[], maxRows: number): Row[] {
  let rows = table;
  const logic = url.searchParams.get("or");
  if (logic !== null) {
    const node = parseLogic(`or${logic}`);
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
  if (url.searchParams.has("offset")) throw new Error("offset paging is not keyset paging");
  const limitParam = url.searchParams.get("limit");
  // PostgREST: the effective limit is min(requested, db-max-rows).
  const requested = limitParam === null ? Number.POSITIVE_INFINITY : Number(limitParam);
  return rows.slice(0, Math.min(requested, maxRows));
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isoDay = (dayIndex: number): string =>
  new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);

const today = () => Math.floor(Date.now() / 86_400_000);

function practiceDays(total: number): Row[] {
  const rows: Row[] = [];
  for (let offset = 0; offset < total; offset += 1) rows.push({ day: isoDay(today() - offset) });
  return rows;
}

function progressTable(url: URL): string {
  return url.pathname.slice("/rest/v1/".length);
}

interface ServeOptions {
  maxRows?: number;
  /** Called with the 1-based request index per table; a non-null Response
   * short-circuits the stand-in. */
  fault?: (table: string, index: number, url: URL) => Response | null;
}

function serve(tables: Record<string, Row[]>, options: ServeOptions = {}): RecordedCall[] {
  const served: RecordedCall[] = [];
  const counts = new Map<string, number>();
  h.respond = (call) => {
    if (call.method !== "GET") return null;
    const url = new URL(call.url);
    const table = progressTable(url);
    if (!(table in tables)) return null;
    served.push(call);
    const index = (counts.get(table) ?? 0) + 1;
    counts.set(table, index);
    const fault = options.fault?.(table, index, url);
    if (fault) return fault;
    try {
      return jsonResponse(200, postgrestSelect(url, tables[table], options.maxRows ?? PAGE));
    } catch (error) {
      if (error instanceof PostgrestError) {
        return jsonResponse(error.status, { code: error.code, message: error.message });
      }
      throw error;
    }
  };
  return served;
}

interface ProgressBody {
  series?: Array<{ day: string; shot_type: string; scoring_model_version: string }>;
  streak?: { practicedToday: boolean; currentDays: number; lastPracticeDate: string | null };
  error?: { message: string };
}

async function progress(
  user: string,
  ip: string,
): Promise<{ status: number; body: ProgressBody | null; text: string }> {
  const auth = { token: fakeGoogleIdToken(user) };
  const res = await h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
  const text = await res.text();
  let body: ProgressBody | null = null;
  try {
    body = JSON.parse(text) as ProgressBody;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

// ─── B1: PostgREST `db-max-rows` below the requested page ─────────────────────
//
// Hosted Supabase lets the project set "Max rows" (default 1 000); PostgREST
// then serves min(limit, max-rows) rows with HTTP 200 and no error. The edge
// fn asks for 1 000 and treats a page shorter than 1 000 as proof of the end,
// so with max-rows=500 EVERY first page is "short" and the read stops after
// 500 rows. The objective — complete or report INCOMPLETE explicitly — is not
// met: this is a silent truncation again (500 instead of 20). Expected: every
// row (the reader keeps paging until an EMPTY page) or a 503.

Deno.test(
  "ATTACK W07-06 B1a: practice_days with max-rows=500 must not be a 200 with 500 of 2 000 days",
  async () => {
    h.reset();
    const total = 2 * PAGE;
    const days = practiceDays(total);
    const served = serve({ practice_days: days, progress_daily: [] }, { maxRows: 500 });
    const { status, body, text } = await progress(
      "07060a01-0000-4000-8000-000000000001",
      "203.0.113.150",
    );
    const pages = served.filter(
      (call) => progressTable(new URL(call.url)) === "practice_days",
    ).length;
    assert(
      status === 503 || (status === 200 && body?.streak?.currentDays === total),
      `status=${status} currentDays=${body?.streak?.currentDays ?? text} after ${pages} page(s) — a 500-row clamp was served as the whole history`,
    );
  },
);

Deno.test(
  "ATTACK W07-06 B1b: progress_daily with max-rows=999 must not silently drop points",
  async () => {
    h.reset();
    const series: Row[] = [];
    const base = today();
    for (let offset = 0; offset < 1_500; offset += 1) {
      series.push({
        day: isoDay(base - offset),
        shot_type: "dink",
        scoring_model_version: "sm-v1",
        shot_count: 1,
        avg_score: 5,
        best_score: 6,
      });
    }
    const served = serve({ practice_days: [], progress_daily: series }, { maxRows: 999 });
    const { status, body, text } = await progress(
      "07060a02-0000-4000-8000-000000000002",
      "203.0.113.151",
    );
    const pages = served.filter(
      (call) => progressTable(new URL(call.url)) === "progress_daily",
    ).length;
    assert(
      status === 503 || (status === 200 && body?.series?.length === series.length),
      `status=${status} series=${body?.series?.length ?? text} of ${series.length} after ${pages} page(s)`,
    );
  },
);

// ─── B2: network failure on a page AFTER the first ────────────────────────────

Deno.test(
  "ATTACK W07-06 B2a: a fetch rejection that outlasts the SDK's retries on page 2 is 503, never a partial 200",
  async () => {
    // postgrest-js 2.112.4 retries GET network errors 3× (1s, 2s, 4s); a single
    // transient reset is therefore absorbed. Sustain the failure for the whole
    // second page so the read cannot recover, and pin that the outcome is 503
    // and that page 1 was not served as the whole history.
    h.reset();
    const days = practiceDays(3 * PAGE);
    const served = serve(
      { practice_days: days, progress_daily: [] },
      {
        fault: (table, index) => {
          if (table === "practice_days" && index >= 2) {
            throw new TypeError("error sending request: connection reset");
          }
          return null;
        },
      },
    );
    const { status, body } = await progress(
      "07060a03-0000-4000-8000-000000000003",
      "203.0.113.152",
    );
    assertEquals(status, 503, JSON.stringify({ status, streak: body?.streak }));
    assertEquals(
      served.filter((call) => progressTable(new URL(call.url)) === "practice_days").length,
      1 + 1 + 3,
      "page 1, then page 2 plus its three SDK retries",
    );
  },
);

Deno.test(
  "ATTACK W07-06 B2f: ONE transient fetch rejection on page 2 is absorbed by the SDK retry and the full history is served",
  async () => {
    h.reset();
    const days = practiceDays(3 * PAGE);
    let failed = false;
    serve(
      { practice_days: days, progress_daily: [] },
      {
        fault: (table, index) => {
          if (table === "practice_days" && index === 2 && !failed) {
            failed = true;
            throw new TypeError("error sending request: connection reset");
          }
          return null;
        },
      },
    );
    const { status, body, text } = await progress(
      "07060a0c-0000-4000-8000-00000000000c",
      "203.0.113.161",
    );
    assertEquals(status, 200, text);
    assertEquals(body?.streak?.currentDays, days.length);
  },
);

Deno.test("ATTACK W07-06 B2b: 429 + Retry-After on page 2 is not a 200", async () => {
  h.reset();
  const days = practiceDays(3 * PAGE);
  serve(
    { practice_days: days, progress_daily: [] },
    {
      fault: (table, index) =>
        table === "practice_days" && index === 2
          ? new Response(JSON.stringify({ message: "Too Many Requests" }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": "7" },
            })
          : null,
    },
  );
  const { status, body } = await progress("07060a04-0000-4000-8000-000000000004", "203.0.113.153");
  assert(status !== 200, JSON.stringify({ status, streak: body?.streak }));
  assert(status === 503 || status === 429, `unexpected status ${status}`);
});

Deno.test("ATTACK W07-06 B2c: a 302 redirect on page 2 is not a 200", async () => {
  h.reset();
  const days = practiceDays(3 * PAGE);
  serve(
    { practice_days: days, progress_daily: [] },
    {
      fault: (table, index) =>
        table === "practice_days" && index === 2
          ? new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } })
          : null,
    },
  );
  const { status } = await progress("07060a05-0000-4000-8000-000000000005", "203.0.113.154");
  assert(status !== 200, `redirect mid-read yielded ${status}`);
});

Deno.test("ATTACK W07-06 B2d: a 200 with a NON-JSON body on page 2 is not a 200", async () => {
  h.reset();
  const days = practiceDays(3 * PAGE);
  serve(
    { practice_days: days, progress_daily: [] },
    {
      fault: (table, index) =>
        table === "practice_days" && index === 2
          ? new Response("<html>502 Bad Gateway</html>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            })
          : null,
    },
  );
  const { status, body } = await progress("07060a06-0000-4000-8000-000000000006", "203.0.113.155");
  assert(status !== 200, JSON.stringify({ status, streak: body?.streak }));
});

Deno.test(
  "ATTACK W07-06 B2e: a 200 whose body is a JSON OBJECT (not an array) on page 2 is the reader's 503, not an unhandled 500",
  async () => {
    // PostgREST returns an object for `Accept: application/vnd.pgrst.object+json`
    // or when a proxy substitutes an error document with status 200.
    h.reset();
    const days = practiceDays(3 * PAGE);
    serve(
      { practice_days: days, progress_daily: [] },
      {
        fault: (table, index) =>
          table === "practice_days" && index === 2
            ? jsonResponse(200, { message: "upstream degraded", rows: [] })
            : null,
      },
    );
    const { status, body, text } = await progress(
      "07060a07-0000-4000-8000-000000000007",
      "203.0.113.156",
    );
    assertEquals(
      status,
      503,
      `object body: status=${status} streak=${JSON.stringify(body?.streak)} ${text.slice(0, 80)}`,
    );
  },
);

// ─── B3: corrupt row on a page boundary ───────────────────────────────────────

Deno.test(
  'ATTACK W07-06 B3: a null `day` as the LAST row of a full page (cursor `day.lt."null"`) is 503, not a partial 200',
  async () => {
    h.reset();
    const days = practiceDays(PAGE + 5);
    // The stand-in sorts nulls with String(null) = "null" which is > any ISO
    // date, so under `day.desc` the null row comes FIRST, not last. Force it to
    // the boundary instead: replace the 1 000th row.
    const table: Row[] = days.map((row, index) => (index === PAGE - 1 ? { day: null } : row));
    const served = serve(
      { practice_days: table, progress_daily: [] },
      {
        fault: (t, index, url) => {
          if (t !== "practice_days" || index !== 1) return null;
          // First page: the honest first 1 000 rows with the null at the end.
          return jsonResponse(
            200,
            postgrestSelect(url, days, PAGE)
              .slice(0, PAGE - 1)
              .concat([{ day: null }]),
          );
        },
      },
    );
    const { status, body } = await progress(
      "07060a08-0000-4000-8000-000000000008",
      "203.0.113.157",
    );
    const pages = served.filter((call) => progressTable(new URL(call.url)) === "practice_days");
    const secondOr = pages[1] ? new URL(pages[1].url).searchParams.get("or") : null;
    assert(
      status !== 200,
      `corrupt boundary row: status=${status} currentDays=${body?.streak?.currentDays} second-page or=${secondOr}`,
    );
  },
);

// ─── B4: interleaved owners (account switch mid-read) ─────────────────────────

Deno.test(
  "ATTACK W07-06 B4: two owners paging concurrently never see each other's rows",
  async () => {
    h.reset();
    const a = "07060a09-0000-4000-8000-000000000009";
    const b = "07060a0a-0000-4000-8000-00000000000a";
    const daysA = practiceDays(2 * PAGE + 1);
    const daysB = practiceDays(7);
    const seriesB: Row[] = [
      {
        day: isoDay(today()),
        shot_type: "drive",
        scoring_model_version: "sm-v9",
        shot_count: 2,
        avg_score: 6,
        best_score: 7,
      },
    ];
    h.respond = (call) => {
      if (call.method !== "GET") return null;
      const url = new URL(call.url);
      const table = progressTable(url);
      if (table !== "practice_days" && table !== "progress_daily") return null;
      const owner = url.searchParams.get("user_id");
      assert(owner === `eq.${a}` || owner === `eq.${b}`, `owner filter missing: ${url.search}`);
      const isA = owner === `eq.${a}`;
      const rows = table === "practice_days" ? (isA ? daysA : daysB) : isA ? [] : seriesB;
      return jsonResponse(200, postgrestSelect(url, rows, PAGE));
    };
    const [ra, rb] = await Promise.all([
      progress(a, "203.0.113.158"),
      progress(b, "203.0.113.159"),
    ]);
    assertEquals(ra.status, 200, ra.text);
    assertEquals(rb.status, 200, rb.text);
    assertEquals(ra.body?.streak?.currentDays, daysA.length);
    assertEquals(ra.body?.series?.length, 0);
    assertEquals(rb.body?.streak?.currentDays, daysB.length);
    assertEquals(rb.body?.series?.length, 1);
  },
);

// ─── B6: unauthorised callers of the paginated route ──────────────────────────

Deno.test(
  "ATTACK W07-06 B6: anon / malformed bearer never reach the inventory reader",
  async () => {
    h.reset();
    const served = serve({ practice_days: practiceDays(3), progress_daily: [] });
    const anon = await h.handler(
      new Request("https://edge.test/functions/v1/api/v1/progress", {
        method: "GET",
        headers: { "x-forwarded-for": "203.0.113.162" },
      }),
    );
    assertEquals(anon.status, 401, await anon.text());
    const garbage = await h.handler(
      new Request("https://edge.test/functions/v1/api/v1/progress", {
        method: "GET",
        headers: { "x-forwarded-for": "203.0.113.163", Authorization: "Bearer not.a.jwt" },
      }),
    );
    assert(garbage.status === 401 || garbage.status === 403, `status ${garbage.status}`);
    assertEquals(served.length, 0, "no PostgREST page was read for an unauthenticated caller");
  },
);

// ─── B7: double submit — the same owner asks twice at once ───────────────────

Deno.test(
  "ATTACK W07-06 B7: two concurrent identical requests both receive the complete history",
  async () => {
    h.reset();
    const user = "07060a0d-0000-4000-8000-00000000000d";
    const days = practiceDays(2 * PAGE + 3);
    serve({ practice_days: days, progress_daily: [] });
    const [first, second] = await Promise.all([
      progress(user, "203.0.113.164"),
      progress(user, "203.0.113.164"),
    ]);
    assertEquals(first.status, 200, first.text);
    assertEquals(second.status, 200, second.text);
    assertEquals(first.body?.streak?.currentDays, days.length);
    assertEquals(second.body?.streak?.currentDays, days.length);
  },
);

// ─── B5: a 503 must not poison the cache; the next honest read is a 200 ──────

Deno.test(
  "ATTACK W07-06 B5: after a mid-read failure, a subsequent successful read is a fresh 200",
  async () => {
    h.reset();
    const user = "07060a0b-0000-4000-8000-00000000000b";
    const days = practiceDays(2 * PAGE + 1);
    let failOnce = true;
    serve(
      { practice_days: days, progress_daily: [] },
      {
        fault: (table, index) => {
          if (table === "practice_days" && index === 2 && failOnce) {
            failOnce = false;
            return jsonResponse(500, { code: "57014", message: "statement timeout" });
          }
          return null;
        },
      },
    );
    const first = await progress(user, "203.0.113.160");
    assertEquals(first.status, 503);
    const second = await progress(user, "203.0.113.160");
    assertEquals(second.status, 200, second.text);
    assertEquals(second.body?.streak?.currentDays, days.length);
  },
);
