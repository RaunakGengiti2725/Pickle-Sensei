// W07-06 adversarial tests — the cursor reader's failure boundaries.
//
// Attacks the contract "readOwnerInventory either proves completion or reports
// INCOMPLETE; consumers never mistake a partial or corrupt inventory for the
// whole set" with sources that misbehave in ways the candidate's own tests do
// not cover: degenerate page sizes, pages that overlap or run backwards while
// still producing distinct cursors, pages that repeat a row, a source that
// never repeats a cursor, and readPage/cursorAfter rejections.
//
// Every test states what the reader OUGHT to do; a failing test is a confirmed
// break (see the attack report), a passing one is an attack that held.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  completedInventoryRows,
  INVENTORY_PAGE_ROWS,
  type InventoryCursorReader,
  readOwnerInventory,
} from "../accountDeletionOperations.ts";

interface Item {
  id: number;
}

const idReader = (
  readPage: InventoryCursorReader<Item, number>["readPage"],
  pageRows?: number,
): InventoryCursorReader<Item, number> => ({
  readPage,
  cursorAfter: (row) => row.id,
  cursorKey: (cursor) => String(cursor),
  ...(pageRows === undefined ? {} : { pageRows }),
});

/** Honest keyset source over `total` rows that honours `limit` exactly. */
function honest(total: number) {
  const calls: Array<{ cursor: number | null; limit: number }> = [];
  const readPage = (cursor: number | null, limit: number) => {
    calls.push({ cursor, limit });
    const start = cursor === null ? 0 : cursor + 1;
    const data: Item[] = [];
    for (let id = start; id < Math.min(total, start + Math.max(0, limit)); id += 1) {
      data.push({ id });
    }
    return Promise.resolve({ data, error: null });
  };
  return { readPage, calls };
}

// ─── A1: degenerate page sizes must not turn a populated inventory into an
//        empty COMPLETE one ────────────────────────────────────────────────────

Deno.test(
  "ATTACK W07-06 A1a: pageRows=0 must not report a populated inventory as COMPLETE+empty",
  async () => {
    const { readPage, calls } = honest(50);
    const outcome = await readOwnerInventory(idReader(readPage, 0)).then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    // Acceptable: a thrown configuration error, or an INCOMPLETE result.
    // Unacceptable: COMPLETE with zero rows for a source that holds 50.
    if (outcome.kind === "resolved") {
      assert(
        outcome.result.status === "INCOMPLETE",
        `pageRows=0 fabricated ${JSON.stringify({
          status: outcome.result.status,
          rows: outcome.result.rows.length,
          pages: outcome.result.pages,
          calls,
        })} for a 50-row inventory`,
      );
      assertEquals(completedInventoryRows(outcome.result), null);
    }
  },
);

Deno.test(
  "ATTACK W07-06 A1b: negative pageRows must not report a populated inventory as COMPLETE+empty",
  async () => {
    const { readPage } = honest(50);
    const outcome = await readOwnerInventory(idReader(readPage, -1)).then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    if (outcome.kind === "resolved") {
      assert(
        outcome.result.status === "INCOMPLETE",
        `pageRows=-1 fabricated ${JSON.stringify({
          status: outcome.result.status,
          rows: outcome.result.rows.length,
        })}`,
      );
    }
  },
);

Deno.test("ATTACK W07-06 A1c: NaN pageRows must not be accepted as a page size", async () => {
  // A NaN limit forwarded to PostgREST is `limit=NaN` (HTTP 400 → INCOMPLETE
  // page_error), but a source that treats NaN as "no limit" returns everything
  // in one page: `batch.length > NaN` and `batch.length < NaN` are both false,
  // so the reader can neither prove completion nor detect overflow and asks
  // for a second page after the last row — which is then COMPLETE. That path
  // depends entirely on the source's NaN handling; the reader must reject NaN
  // (or report INCOMPLETE) rather than let the source decide.
  const { readPage, calls } = honest(50);
  const outcome = await readOwnerInventory(
    idReader((cursor, limit) => {
      const effective = Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER;
      return readPage(cursor, effective);
    }, Number.NaN),
  ).then(
    (result) => ({ kind: "resolved" as const, result }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  if (outcome.kind === "resolved") {
    assert(
      outcome.result.status === "INCOMPLETE",
      `NaN pageRows was forwarded to the source (${calls.length} calls) and yielded ${outcome.result.status}`,
    );
  }
});

Deno.test("ATTACK W07-06 A1d: a fractional pageRows is not a valid page size", async () => {
  const { readPage } = honest(5);
  const outcome = await readOwnerInventory(idReader(readPage, 2.5)).then(
    (result) => ({ kind: "resolved" as const, result }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  if (outcome.kind === "resolved") {
    assert(
      outcome.result.status === "INCOMPLETE",
      `pageRows=2.5 accepted: ${JSON.stringify({ status: outcome.result.status, pages: outcome.result.pages })}`,
    );
  }
});

// ─── A2: a source whose pages overlap or run backwards produces DISTINCT
//        cursors, so the stall detector never fires — the reader must still
//        refuse to call the result COMPLETE ─────────────────────────────────────

Deno.test(
  "ATTACK W07-06 A2a: overlapping pages (rows at or before the cursor) must not be COMPLETE",
  async () => {
    // Page 1: 0..9, page 2: 5..14 (the source re-serves 5 rows it already
    // served), page 3: 15..17 (short → "complete"). Every cursor is distinct.
    const pages: Item[][] = [
      Array.from({ length: 10 }, (_, id) => ({ id })),
      Array.from({ length: 10 }, (_, i) => ({ id: 5 + i })),
      Array.from({ length: 3 }, (_, i) => ({ id: 15 + i })),
    ];
    let call = 0;
    const result = await readOwnerInventory(
      idReader(() => Promise.resolve({ data: pages[call++] ?? [], error: null }), 10),
    );
    const ids = result.rows.map((row) => row.id);
    const distinct = new Set(ids).size;
    assert(
      result.status === "INCOMPLETE" || distinct === ids.length,
      `reader reported ${result.status} with ${ids.length} rows of which ${distinct} are distinct (duplicates ${JSON.stringify(
        ids.filter((id, index) => ids.indexOf(id) !== index),
      )})`,
    );
  },
);

Deno.test(
  "ATTACK W07-06 A2b: pages that run BACKWARDS (cursor not honoured, order unstable) must not be COMPLETE",
  async () => {
    // The source ignores the cursor and returns pages in reverse: 20..29, then
    // 10..19, then 0..9, then []. Distinct cursors each time, never a repeat.
    const pages: Item[][] = [
      Array.from({ length: 10 }, (_, i) => ({ id: 20 + i })),
      Array.from({ length: 10 }, (_, i) => ({ id: 10 + i })),
      Array.from({ length: 10 }, (_, i) => ({ id: i })),
    ];
    let call = 0;
    const result = await readOwnerInventory(
      idReader(() => Promise.resolve({ data: pages[call++] ?? [], error: null }), 10),
    );
    // Rows 0..29 are all present exactly once, so a set-equality consumer would
    // be fine; but the reader has proven nothing about the cursor being
    // honoured. The pin here is the weaker, undeniable one: a keyset read that
    // received a row NOT strictly after its cursor did not complete honestly.
    const received = result.rows.map((row) => row.id);
    const violates = received.some(
      (id, index) => index > 0 && id <= received[index - 1] && index % 10 === 0,
    );
    assert(
      result.status === "INCOMPLETE" || !violates,
      `source served rows at/before the cursor (${JSON.stringify(received.slice(8, 12))}) and the reader said ${result.status}`,
    );
  },
);

Deno.test(
  "ATTACK W07-06 A2c: a page that repeats one row inside itself is not a clean inventory",
  async () => {
    const page: Item[] = [{ id: 0 }, { id: 1 }, { id: 1 }, { id: 2 }];
    const result = await readOwnerInventory(
      idReader(() => Promise.resolve({ data: page, error: null }), 10),
    );
    const ids = result.rows.map((row) => row.id);
    assert(
      result.status === "INCOMPLETE" || new Set(ids).size === ids.length,
      `duplicate row inside a page passed through as ${result.status}: ${JSON.stringify(ids)}`,
    );
  },
);

// ─── A3: a source that never repeats a cursor but never ends — the reader has
//        no page/row/time budget ───────────────────────────────────────────────

Deno.test(
  "ATTACK W07-06 A3: a runaway source (fresh full page every call, cursor ignored) must be bounded",
  async () => {
    // Each call returns `limit` rows with ids that keep growing, so the cursor
    // key is always new and no page is ever short. A finite inventory cannot do
    // this; a source that ignores the cursor AND has unstable order can. The
    // reader must give up at SOME budget instead of reading until the isolate
    // is killed. The budget below is generous: 5_000 pages = 5_000_000 rows of
    // the shipping page size — far beyond any owner's history.
    const BUDGET_PAGES = 5_000;
    let calls = 0;
    const reader = idReader((_cursor, limit) => {
      calls += 1;
      if (calls > BUDGET_PAGES) {
        throw new Error(`reader exceeded ${BUDGET_PAGES} pages without giving up`);
      }
      const base = calls * limit;
      return Promise.resolve({
        data: Array.from({ length: limit }, (_, i) => ({ id: base + i })),
        error: null,
      });
    }, 4);
    const outcome = await readOwnerInventory(reader).then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    if (outcome.kind === "rejected") {
      throw new Error(
        `unbounded: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
      );
    }
    assertEquals(
      outcome.result.status,
      "INCOMPLETE",
      `runaway source ended as ${outcome.result.status}`,
    );
  },
);

// ─── A4: exceptions thrown by the source or the cursor derivation ───────────

Deno.test(
  "ATTACK W07-06 A4a: a readPage that THROWS (not an error envelope) must be INCOMPLETE, not a rejection",
  async () => {
    // The contract is "COMPLETE or INCOMPLETE"; a supabase-js query never
    // throws, but a custom reader (the deletion/cleanup consumers this reader
    // is built for) may.
    const rejected = await readOwnerInventory(
      idReader(() => Promise.reject(new TypeError("fetch failed: connection reset"))),
    ).then(
      () => false,
      () => true,
    );
    assert(
      !rejected,
      "readPage rejection propagated out of readOwnerInventory instead of INCOMPLETE",
    );
  },
);

Deno.test(
  "ATTACK W07-06 A4b: a cursorAfter that throws mid-read must be INCOMPLETE, not a rejection",
  async () => {
    const { readPage } = honest(30);
    let derivations = 0;
    const outcome = await readOwnerInventory<Item, number>({
      readPage,
      cursorAfter: (row) => {
        derivations += 1;
        if (derivations === 2) throw new Error("invalid keyset column: Day");
        return row.id;
      },
      cursorKey: (cursor) => String(cursor),
      pageRows: 10,
    }).then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    assert(
      outcome.kind === "resolved" && outcome.result.status === "INCOMPLETE",
      `cursorAfter exception became ${outcome.kind}${outcome.kind === "resolved" ? ` ${outcome.result.status}` : ""}`,
    );
  },
);

// ─── A5: attacks that the reader is expected to hold (recorded as tried) ─────

Deno.test("ATTACK W07-06 A5a: the default page size stays at PostgREST's hosted max_rows", () => {
  assertEquals(INVENTORY_PAGE_ROWS, 1_000);
});

Deno.test(
  "ATTACK W07-06 A5b: rows inserted or deleted between pages neither duplicate nor skip (keyset)",
  async () => {
    // Live table: ids 0..24, page size 10, ascending keyset. After page 1 is
    // served, delete ids 3 and 4 (already served) and insert 100 (sorts after
    // everything). After page 2, delete id 24 (not yet served). Expected: rows
    // 0..23 present exactly once, 24 absent (deleted before it was read), 100
    // present (it lies after the cursor and is reached).
    const table = new Set<number>(Array.from({ length: 25 }, (_, id) => id));
    let call = 0;
    const result = await readOwnerInventory(
      idReader((cursor, limit) => {
        call += 1;
        if (call === 2) {
          table.delete(3);
          table.delete(4);
          table.add(100);
        }
        if (call === 3) table.delete(24);
        const data = [...table]
          .filter((id) => cursor === null || id > cursor)
          .sort((a, b) => a - b)
          .slice(0, limit)
          .map((id) => ({ id }));
        return Promise.resolve({ data, error: null });
      }, 10),
    );
    assertEquals(result.status, "COMPLETE");
    const ids = result.rows.map((row) => row.id);
    assertEquals(new Set(ids).size, ids.length, "no duplicates across a mutating read");
    for (let id = 0; id < 24; id += 1) assert(ids.includes(id), `row ${id} skipped`);
    assert(!ids.includes(24), "row deleted before its page was read is absent");
    assert(ids.includes(100), "row inserted after the cursor is reached");
  },
);

Deno.test(
  "ATTACK W07-06 A5c: a 429 + Retry-After page is INCOMPLETE page_error with httpStatus 429",
  async () => {
    const { readPage } = honest(30);
    let call = 0;
    const result = await readOwnerInventory(
      idReader((cursor, limit) => {
        call += 1;
        if (call === 2) {
          return Promise.resolve({
            data: null,
            error: { message: "Too Many Requests", code: "PGRST429" },
            status: 429,
          });
        }
        return readPage(cursor, limit);
      }, 10),
    );
    assert(result.status === "INCOMPLETE");
    assertEquals(result.reason, "page_error");
    assertEquals(result.httpStatus, 429);
    assertEquals(completedInventoryRows(result), null);
  },
);

Deno.test(
  "ATTACK W07-06 A5d: an error envelope that ALSO carries data is INCOMPLETE (error wins)",
  async () => {
    const result = await readOwnerInventory(
      idReader(() =>
        Promise.resolve({
          data: [{ id: 0 }, { id: 1 }],
          error: { message: "partial result", code: "XX000" },
          status: 200,
        }),
      ),
    );
    assertEquals(result.status, "INCOMPLETE");
    assertEquals(completedInventoryRows(result), null);
  },
);

Deno.test(
  "ATTACK W07-06 A5e: `data: null` with no error is no evidence of emptiness — must not be COMPLETE+empty",
  async () => {
    // PostgREST never returns a null body with 200; supabase-js yields
    // `data: null` only alongside an error. A reader that gets `null` without
    // an error has no evidence at all — for a deletion consumer, COMPLETE+[]
    // here reads as "nothing left to delete".
    const result = await readOwnerInventory(
      idReader(() => Promise.resolve({ data: null, error: null })),
    );
    assertEquals(
      result.status,
      "INCOMPLETE",
      `null page became ${result.status} with ${result.rows.length} rows`,
    );
    assertEquals(completedInventoryRows(result), null);
  },
);

Deno.test(
  "ATTACK W07-06 A5f: 17 001 rows at the shipping page size read completely with exactly 18 pages",
  async () => {
    const { readPage, calls } = honest(17 * INVENTORY_PAGE_ROWS + 1);
    const result = await readOwnerInventory(idReader(readPage));
    assertEquals(result.status, "COMPLETE");
    assertEquals(result.rows.length, 17_001);
    assertEquals(calls.length, 18);
  },
);
