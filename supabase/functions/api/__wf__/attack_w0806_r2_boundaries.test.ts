// W08-06 r2 adversarial tests — boundary values, corrupt pages, replayed rows
// and cursor injection against the candidate's inventory contract
// (readOwnerInventory / verifyOwnerNamespacesEmpty / probeOwnerNamespaces /
// postgrestKeysetBefore) with an in-memory page source. No database needed, so
// these always run under `deno task test`. Every test asserts the EXPECTED
// behaviour: a failure on 4d7ccb87 is a confirmed break.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ACCOUNT_OWNER_NAMESPACES,
  INVENTORY_MAX_PAGES,
  INVENTORY_READ_ATTEMPTS,
  type InventoryPage,
  type OwnerNamespace,
  type OwnerNamespacePageReader,
  postgrestKeysetBefore,
  probeOwnerNamespaces,
  readOwnerInventory,
  verifyOwnerNamespacesEmpty,
} from "../accountDeletionOperations.ts";

const OWNER = "0806a7ac-0000-4000-8000-0000000000aa";
const OTHER = "0806a7ac-0000-4000-8000-0000000000bb";
const PHASES: OwnerNamespace = ACCOUNT_OWNER_NAMESPACES.find((n) => n.table === "shot_phases")!;
const DRILLS: OwnerNamespace = ACCOUNT_OWNER_NAMESPACES.find((n) =>
  n.table === "user_saved_drills"
)!;

type Row = Record<string, unknown>;
type PageFn = (
  namespace: OwnerNamespace,
  before: string | null,
  limit: number,
  call: number,
) => InventoryPage<Row> | Promise<InventoryPage<Row>>;

/** Page source that answers only for one table; every other namespace is empty. */
function source(table: string, page: PageFn): OwnerNamespacePageReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readOwnerNamespacePage: (namespace, _owner, before, limit) => {
      if (namespace.table !== table) return Promise.resolve({ data: [], error: null });
      calls.push(before ?? "<first>");
      return Promise.resolve(page(namespace, before, limit, calls.length));
    },
  };
}

const unread = (
  verdicts: Awaited<ReturnType<typeof verifyOwnerNamespacesEmpty>>,
  table: string,
) => {
  const verdict = verdicts.find((v) => v.table === table);
  assert(verdict && verdict.outcome === "unread", JSON.stringify(verdict));
  return verdict;
};

// ─── boundary page sizes ─────────────────────────────────────────────────────

Deno.test("ATTACK W08-06 r2 #10 (boundary): degenerate page sizes never reach the source and never complete", async () => {
  for (const pageRows of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 31)]) {
    let reads = 0;
    const result = await readOwnerInventory<Row, string>({
      readPage: () => {
        reads += 1;
        return Promise.resolve({ data: [], error: null });
      },
      cursorAfter: (row) => String(row.id),
      cursorKey: (cursor) => cursor,
      pageRows,
    });
    assertEquals(result.status, "INCOMPLETE", String(pageRows));
    assert(result.status === "INCOMPLETE" && result.reason === "invalid_page_size");
    assertEquals(reads, 0, `page size ${pageRows} reached the source`);
  }
  // the largest legal page is still legal
  const max = await readOwnerInventory<Row, string>({
    readPage: () => Promise.resolve({ data: [], error: null }),
    cursorAfter: (row) => String(row.id),
    cursorKey: (cursor) => cursor,
    pageRows: Number.MAX_SAFE_INTEGER,
  });
  assertEquals(max.status, "COMPLETE");
});

// ─── corrupt / partial pages ─────────────────────────────────────────────────

Deno.test("ATTACK W08-06 r2 #11 (corrupt state): a page the source cannot describe is `unread`, never `empty` and never `residue`", async () => {
  const corrupt: Array<[string, InventoryPage<Row>]> = [
    ["data:null without error", { data: null, error: null }],
    ["data is an object", { data: {} as unknown as Row[], error: null }],
    ["row is not an object", { data: [null as unknown as Row], error: null }],
    ["row lacks the owner column", { data: [{ shot_id: "s", phase_key: "p" }], error: null }],
    [
      "row belongs to another owner",
      { data: [{ user_id: OTHER, shot_id: "s", phase_key: "p" }], error: null },
    ],
    [
      "owner column differs only in case",
      { data: [{ user_id: OWNER.toUpperCase(), shot_id: "s", phase_key: "p" }], error: null },
    ],
    ["key column null", { data: [{ user_id: OWNER, shot_id: "s", phase_key: null }], error: null }],
    ["key column missing", { data: [{ user_id: OWNER, shot_id: "s" }], error: null }],
    [
      "key column NaN",
      { data: [{ user_id: OWNER, shot_id: "s", phase_key: Number.NaN }], error: null },
    ],
    [
      "key column Infinity",
      {
        data: [{ user_id: OWNER, shot_id: "s", phase_key: Number.POSITIVE_INFINITY }],
        error: null,
      },
    ],
    ["key column boolean", {
      data: [{ user_id: OWNER, shot_id: "s", phase_key: true }],
      error: null,
    }],
    [
      "key column object",
      { data: [{ user_id: OWNER, shot_id: "s", phase_key: { k: 1 } }], error: null },
    ],
    [
      "page overflow (server ignored limit)",
      {
        data: Array.from({ length: 1_001 }, (_, i) => ({
          user_id: OWNER,
          shot_id: "s",
          phase_key: `p${i}`,
        })),
        error: null,
      },
    ],
    ["error with status 0", { data: null, error: { message: "x" }, status: 0 }],
    ["error AND data (both set)", { data: [], error: { message: "x", code: "PGRST" } }],
  ];
  for (const [label, page] of corrupt) {
    const reader = source("shot_phases", () => page);
    const verdicts = await verifyOwnerNamespacesEmpty(reader, OWNER);
    const verdict = unread(verdicts, "shot_phases");
    assert(
      ["malformed_page", "page_overflow", "page_error"].includes(verdict.reason),
      `${label}: ${verdict.reason}`,
    );
    // a page error is retried INVENTORY_READ_ATTEMPTS times; a malformed page
    // is not retried (retrying cannot make the source describable)
    assertEquals(
      reader.calls.length,
      verdict.reason === "page_error" ? INVENTORY_READ_ATTEMPTS : 1,
      label,
    );
    // the pre-flight one-row probe refuses every one of these pages too
    const probe = await probeOwnerNamespaces(source("shot_phases", () => page), OWNER);
    const probed = probe.find((p) => p.table === "shot_phases")!;
    assertEquals(probed.outcome, "unread", label);
  }
});

Deno.test("ATTACK W08-06 r2 #12 (corrupt state): a probe page of exactly one describable row is readable, two rows for limit 1 is overflow, an owner row plus a stranger's row is unread", async () => {
  const row = { user_id: OWNER, slug: "a" };
  const readable = await probeOwnerNamespaces(
    source("user_saved_drills", (_n, _b, limit) => {
      assertEquals(limit, 1);
      return { data: [row], error: null };
    }),
    OWNER,
  );
  assertEquals(readable.find((p) => p.table === "user_saved_drills")!.outcome, "readable");
  const overflow = await probeOwnerNamespaces(
    source(
      "user_saved_drills",
      () => ({ data: [row, { user_id: OWNER, slug: "b" }], error: null }),
    ),
    OWNER,
  );
  const over = overflow.find((p) => p.table === "user_saved_drills")!;
  assert(over.outcome === "unread" && over.reason === "page_overflow");
  const mixed = await probeOwnerNamespaces(
    source("user_saved_drills", () => ({ data: [{ user_id: OTHER, slug: "a" }], error: null })),
    OWNER,
  );
  const stranger = mixed.find((p) => p.table === "user_saved_drills")!;
  assert(stranger.outcome === "unread" && stranger.reason === "malformed_page");
});

// ─── replayed rows / page-budget exhaustion ──────────────────────────────────

Deno.test("ATTACK W08-06 r2 #13 (replay): a source that re-serves a row — inside one page, on the next page, or after 999 honest pages — is `unread`, and a source that never ends stops at INVENTORY_MAX_PAGES", async () => {
  const drill = (slug: string) => ({ user_id: OWNER, slug });
  const twiceInOnePage = await verifyOwnerNamespacesEmpty(
    source(
      "user_saved_drills",
      () => ({ data: [drill("b"), drill("a"), drill("b")], error: null }),
    ),
    OWNER,
  );
  assertEquals(unread(twiceInOnePage, "user_saved_drills").reason, "repeated_row");

  const replayedNextPage = await verifyOwnerNamespacesEmpty(
    source(
      "user_saved_drills",
      (_n, before) =>
        before === null
          ? { data: [drill("z"), drill("y")], error: null }
          : { data: [drill("y")], error: null },
    ),
    OWNER,
  );
  assertEquals(unread(replayedNextPage, "user_saved_drills").reason, "repeated_row");

  // 999 honest one-row pages, then the first row again
  const late = source("user_saved_drills", (_n, _b, _l, call) => ({
    data: [drill(call < 1_000 ? `d${String(call).padStart(4, "0")}` : "d0001")],
    error: null,
  }));
  const lateResult = await readOwnerInventory<Row, string>({
    readPage: (cursor, limit) =>
      late.readOwnerNamespacePage(DRILLS, OWNER, cursor, limit) as Promise<InventoryPage<Row>>,
    cursorAfter: (row) => String(row.slug),
    cursorKey: (cursor) => cursor,
    pageRows: 1,
  });
  assert(lateResult.status === "INCOMPLETE" && lateResult.reason === "repeated_row");
  assertEquals(lateResult.pages, 1_000);

  // never-ending unique rows: stop at the budget, never COMPLETE
  const endless = await readOwnerInventory<Row, string>({
    readPage: (cursor) => Promise.resolve({ data: [{ slug: `${cursor ?? "d"}x` }], error: null }),
    cursorAfter: (row) => String(row.slug),
    cursorKey: (cursor) => cursor,
    pageRows: 1,
  });
  assert(endless.status === "INCOMPLETE" && endless.reason === "page_budget");
  assertEquals(endless.pages, INVENTORY_MAX_PAGES);
  assertEquals(endless.rows.length, INVENTORY_MAX_PAGES);
});

Deno.test("ATTACK W08-06 r2 #14 (network): page errors are retried exactly INVENTORY_READ_ATTEMPTS times from the FIRST page, an error on page 2 discards page 1, and a success on the last attempt is a verdict", async () => {
  const drill = (slug: string) => ({ user_id: OWNER, slug });
  const flaky = source("user_saved_drills", (_n, before, _l, call) => {
    // attempts 1 and 2 fail on their second page; attempt 3 is clean
    if (call <= 4) {
      return before === null
        ? { data: [drill("b")], error: null }
        : { data: null, error: { message: "boom" }, status: 502 };
    }
    return before === null ? { data: [drill("b")], error: null } : { data: [], error: null };
  });
  const verdicts = await verifyOwnerNamespacesEmpty(flaky, OWNER);
  const verdict = verdicts.find((v) => v.table === "user_saved_drills")!;
  assert(verdict.outcome === "residue", JSON.stringify(verdict));
  assertEquals(verdict.rows, 1, "rows from failed attempts leaked into the count");
  assertEquals(verdict.pages, 2);
  assertEquals(flaky.calls, [
    "<first>",
    'slug.lt."b"',
    "<first>",
    'slug.lt."b"',
    "<first>",
    'slug.lt."b"',
  ]);

  const dead = source("user_saved_drills", () => ({
    data: null,
    error: { message: "down", code: "PGRST000" },
    status: 503,
  }));
  const down = unread(await verifyOwnerNamespacesEmpty(dead, OWNER), "user_saved_drills");
  assertEquals(down.reason, "page_error");
  assertEquals(down.httpStatus, 503);
  assertEquals(down.code, "PGRST000");
  assertEquals(dead.calls.length, INVENTORY_READ_ATTEMPTS);

  const thrower = source("user_saved_drills", () => {
    throw new TypeError("fetch failed");
  });
  const threw = unread(await verifyOwnerNamespacesEmpty(thrower, OWNER), "user_saved_drills");
  assertEquals(threw.reason, "page_error");
  assertEquals(threw.httpStatus, null);
  assertEquals(thrower.calls.length, INVENTORY_READ_ATTEMPTS);
});

// ─── cursor injection ────────────────────────────────────────────────────────

Deno.test("ATTACK W08-06 r2 #15 (injection): hostile key VALUES are quoted, hostile key COLUMNS are refused", () => {
  const hostile = `a"b\\c,d)e(f.g%h&i=j\n\tk é`;
  assertEquals(
    postgrestKeysetBefore([
      { column: "shot_id", value: hostile },
      { column: "phase_key", value: `"` },
    ]),
    `shot_id.lt."a\\"b\\\\c,d)e(f.g%h&i=j\n\tk é",and(shot_id.eq."a\\"b\\\\c,d)e(f.g%h&i=j\n\tk é",phase_key.lt."\\"")`,
  );
  assertEquals(postgrestKeysetBefore([{ column: "id", value: "" }]), 'id.lt.""');
  for (
    const column of [
      "",
      "id.desc",
      "id,slug",
      "id)",
      "(id",
      '"id"',
      "ID",
      "user id",
      "1id",
      "id;drop",
      "id\n",
      "ïd",
    ]
  ) {
    assertThrows(
      () => postgrestKeysetBefore([{ column, value: "v" }]),
      Error,
      "invalid keyset column",
    );
  }
  assertThrows(() => postgrestKeysetBefore([]), Error, "at least one column");
  // the registry itself only names safe columns
  for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
    postgrestKeysetBefore(namespace.keyColumns.map((column) => ({ column, value: "v" })));
    assert(/^[a-z_][a-z0-9_]*$/.test(namespace.ownerColumn), namespace.table);
    assert(/^[a-z_][a-z0-9_]*$/.test(namespace.table), namespace.table);
  }
  // the compound key's second page must be reachable for the three compound namespaces
  assertEquals(PHASES.keyColumns, ["shot_id", "phase_key"]);
});

Deno.test("ATTACK W08-06 r2 #16 (boundary): owner ids are compared canonically — an upper-case caller id still matches the lower-case rows PostgREST returns, and a non-UUID owner is refused before any read", async () => {
  const drill = { user_id: OWNER, slug: "a" };
  const upper = await verifyOwnerNamespacesEmpty(
    source(
      "user_saved_drills",
      (_n, before) => ({ data: before === null ? [drill] : [], error: null }),
    ),
    OWNER.toUpperCase(),
  );
  const verdict = upper.find((v) => v.table === "user_saved_drills")!;
  assert(verdict.outcome === "residue", JSON.stringify(verdict));
  const probe = await probeOwnerNamespaces(
    source("user_saved_drills", () => ({ data: [drill], error: null })),
    OWNER.toUpperCase(),
  );
  assertEquals(probe.find((p) => p.table === "user_saved_drills")!.outcome, "readable");
  for (const bad of ["", "not-a-uuid", `${OWNER}'`, "0806a7ac-0000-4000-8000-0000000000a"]) {
    const reader = source("user_saved_drills", () => ({ data: [drill], error: null }));
    await assertRejects(
      () => verifyOwnerNamespacesEmpty(reader, bad),
      Error,
      "Invalid deletion owner",
    );
    await assertRejects(() => probeOwnerNamespaces(reader, bad), Error, "Invalid deletion owner");
    assertEquals(reader.calls.length, 0, bad);
  }
});
