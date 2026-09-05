// STRESS — edge-drills-media, lens failure-load, part 2: LOAD + MEMORY + SLUG FUZZ.
//
// Drives the REAL edge handler in-process (see stress_edge_drills_media_harness.ts)
// against healthy in-memory upstreams and records, per request, latency and the
// number of Supabase round trips (Auth + PostgREST HTTP calls) so that a hot
// path spending >3 round trips per request is caught as a finding. Then a
// distinct-user campaign measures the per-isolate L1 auth cache and rate-limit
// memory under many users, and a seeded slug fuzzer walks GET/PUT/DELETE with
// hostile slugs. Everything is seeded (STRESS_SEED) and replayable.
//
// Scale knobs (small defaults so the suite stays fast):
//   STRESS_ITER   requests in the hot-path campaign        (default 1_000)
//   STRESS_USERS  distinct users in the memory campaign    (default 2_000; run 20_000)
//   STRESS_FUZZ   slug fuzz iterations                     (default 300)
//   STRESS_SEED   campaign seed                            (default 20260905)
// Artifacts: artifacts/stress-edge-drills-media/latest/{load_hot_path,load_users,slug_fuzz}.json

import { assert, assertEquals } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import {
  answerWithin,
  edgeRequest,
  envInt,
  histogram,
  loadStressHarness,
  percentile,
  Prng,
  readJson,
  sessionToken,
  STRESS_SEED,
  type StressHarness,
  writeArtifact,
} from "./stress_edge_drills_media_harness.ts";

const ITER = envInt("STRESS_ITER", 1_000);
const USERS = envInt("STRESS_USERS", 2_000);
const FUZZ = envInt("STRESS_FUZZ", 300);
const ROUND_TRIP_BUDGET = 3;
const STALL_BUDGET_MS = 1_200;

type Route = "list" | "list_q" | "detail" | "saved" | "put" | "delete";
const ROUTES: Route[] = ["list", "list_q", "detail", "saved", "put", "delete"];

function requestFor(
  route: Route,
  slug: string,
  token: string,
  ip: string,
): Request {
  switch (route) {
    case "list":
      return edgeRequest("GET", "/v1/catalog/drills", { token, ip });
    case "list_q":
      return edgeRequest(
        "GET",
        `/v1/catalog/drills?q=${
          encodeURIComponent(slug.slice(0, 4))
        }&family=dinking`,
        { token, ip },
      );
    case "detail":
      return edgeRequest("GET", `/v1/catalog/drills/${slug}`, { token, ip });
    case "saved":
      return edgeRequest("GET", "/v1/me/saved-drills", { token, ip });
    case "put":
      return edgeRequest("PUT", `/v1/me/saved-drills/${slug}`, {
        token,
        ip,
        body: { slug, saved: true },
      });
    case "delete":
      return edgeRequest("DELETE", `/v1/me/saved-drills/${slug}`, {
        token,
        ip,
      });
  }
}

function roundTrips(h: StressHarness, mark: number) {
  const calls = h.callsSince(mark);
  return {
    auth: calls.filter((c) => c.upstream === "auth").length,
    rest: calls.filter((c) => c.upstream === "rest").length,
    upstash: calls.filter((c) => c.upstream === "upstash").length,
  };
}

interface HotRow {
  i: number;
  seed: number;
  route: Route;
  slug: string;
  user: number;
  status: number;
  ms: number;
  auth: number;
  rest: number;
  supabase: number;
}

Deno.test(`stress/load: ${ITER} requests — p50/p95 latency + Supabase round trips per request`, async () => {
  const h = await loadStressHarness({ redis: false });
  const catalog = await drillCatalog();
  const slugs = catalog.map((d) => d.slug);
  const prng = new Prng(STRESS_SEED).fork("load-hot-path");
  const USER_POOL = 50;
  const users = Array.from({ length: USER_POOL }, (_, i) => {
    const sub = new Prng(STRESS_SEED).fork(`hot-user-${i}`).uuid();
    return {
      sub,
      token: sessionToken(sub),
      ip: new Prng(STRESS_SEED).fork(`hot-ip-${i}`).ip(),
    };
  });

  const rows: HotRow[] = [];
  const nonSuccess: HotRow[] = [];
  for (let i = 0; i < ITER; i++) {
    const seed = (prng.seed ^ i) >>> 0;
    const step = new Prng(seed);
    const route = step.pick(ROUTES);
    const slug = step.pick(slugs);
    const userIx = step.int(0, USER_POOL - 1);
    const u = users[userIx];
    const mark = h.calls.length;
    const { response, stalled, ms, pending } = await answerWithin(
      h.handler,
      requestFor(route, slug, u.token, u.ip),
      STALL_BUDGET_MS,
    );
    if (stalled) await pending;
    const status = response?.status ?? 0;
    if (response) await response.body?.cancel();
    const trips = roundTrips(h, mark);
    const row: HotRow = {
      i,
      seed,
      route,
      slug,
      user: userIx,
      status,
      ms,
      auth: trips.auth,
      rest: trips.rest,
      supabase: trips.auth + trips.rest,
    };
    rows.push(row);
    const okStatus = route === "delete" ? 204 : 200;
    if (status !== okStatus) nonSuccess.push(row);
  }

  const byRoute: Record<string, unknown> = {};
  const overBudget: HotRow[] = [];
  for (const route of ROUTES) {
    const sub = rows.filter((r) => r.route === route);
    const lat = sub.map((r) => r.ms).sort((a, b) => a - b);
    const trips = sub.map((r) => r.supabase);
    const worst = sub.filter((r) => r.supabase > ROUND_TRIP_BUDGET);
    overBudget.push(...worst);
    byRoute[route] = {
      n: sub.length,
      p50_ms: percentile(lat, 50),
      p95_ms: percentile(lat, 95),
      p99_ms: percentile(lat, 99),
      max_ms: lat[lat.length - 1] ?? 0,
      supabase_round_trips: histogram(trips),
      rest_round_trips: histogram(sub.map((r) => r.rest)),
      auth_round_trips: histogram(sub.map((r) => r.auth)),
      max_supabase_round_trips: Math.max(0, ...trips),
      over_budget: worst.length,
      statuses: histogram(sub.map((r) => r.status)),
    };
  }
  const all = rows.map((r) => r.ms).sort((a, b) => a - b);
  const authCalls = h.callsTo("auth").length;
  const summary = {
    seed: STRESS_SEED,
    iterations: ITER,
    users: USER_POOL,
    p50_ms: percentile(all, 50),
    p95_ms: percentile(all, 95),
    p99_ms: percentile(all, 99),
    auth_calls_total: authCalls,
    auth_calls_expected_max: USER_POOL,
    rest_calls_total: h.callsTo("rest").length,
    round_trip_budget: ROUND_TRIP_BUDGET,
    over_budget_requests: overBudget.length,
    non_success: nonSuccess.length,
    by_route: byRoute,
  };
  const path = await writeArtifact("load_hot_path.json", {
    summary,
    over_budget: overBudget.slice(0, 50),
    non_success: nonSuccess.slice(0, 50),
    replay:
      "STRESS_SEED=<seed> STRESS_ITER=<n> deno test -A stress_edge_drills_media_load.test.ts; row.seed = (fork('load-hot-path').seed ^ i)",
    rows,
  });
  console.log(
    `[stress/load] ${ITER} requests p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms auth=${authCalls} rest=${summary.rest_calls_total} over-budget=${overBudget.length} → ${path}`,
  );

  // Pins. Auth is consulted at most once per user per window — never per request.
  assert(
    authCalls <= USER_POOL,
    `auth called ${authCalls}× for ${USER_POOL} users`,
  );
  assertEquals(
    nonSuccess.length,
    0,
    `non-success rows: ${JSON.stringify(nonSuccess.slice(0, 5))}`,
  );
  // Hot-path budget: no drills route may do more than 3 Supabase round trips
  // per request once the session is cached (PUT = upsert + read-back = 2; a
  // cold request adds exactly one Auth call).
  assertEquals(
    overBudget.length,
    0,
    `${overBudget.length} requests exceeded ${ROUND_TRIP_BUDGET} Supabase round trips: ${
      JSON.stringify(overBudget.slice(0, 5))
    }`,
  );
  h.dispose();
});

Deno.test(`stress/load: ${USERS} distinct users — L1 auth cache + rate-limit memory`, async () => {
  const h = await loadStressHarness({ redis: false });
  const prng = new Prng(STRESS_SEED).fork("load-users");
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = Deno.memoryUsage();
  const started = performance.now();
  const statuses: number[] = [];
  const authLatency: number[] = [];
  const firstSub = prng.uuid();
  // Minted ONCE: the token carries `exp` (whole seconds) and the cache is
  // keyed by token hash, so a re-minted token a second later is a different key.
  const firstUser = {
    sub: firstSub,
    token: sessionToken(firstSub),
    ip: prng.ip(),
  };
  for (let i = 0; i < USERS; i++) {
    const token = i === 0 ? firstUser.token : sessionToken(prng.uuid());
    const ip = i === 0 ? firstUser.ip : prng.ip();
    const t0 = performance.now();
    const response = await h.handler(
      edgeRequest("GET", "/v1/catalog/drills", { token, ip }),
    );
    authLatency.push(performance.now() - t0);
    statuses.push(response.status);
    await response.body?.cancel();
  }
  const elapsedMs = performance.now() - started;
  gc?.();
  const heapAfter = Deno.memoryUsage();
  const authCalls = h.callsTo("auth").length;

  // Probe the L1 bound: the FIRST user's token is either still cached (auth
  // not re-consulted) or was evicted by the bounded cache (one Auth call).
  const mark = h.calls.length;
  const probe = await h.handler(
    edgeRequest("GET", "/v1/catalog/drills", {
      token: firstUser.token,
      ip: firstUser.ip,
    }),
  );
  await probe.body?.cancel();
  const probeAuth = roundTrips(h, mark).auth;

  const sorted = authLatency.slice().sort((a, b) => a - b);
  const result = {
    seed: STRESS_SEED,
    users: USERS,
    statuses: histogram(statuses),
    auth_calls: authCalls,
    elapsed_ms: Math.round(elapsedMs),
    p50_ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95_ms: Math.round(percentile(sorted, 95) * 100) / 100,
    heap_before_bytes: heapBefore.heapUsed,
    heap_after_bytes: heapAfter.heapUsed,
    heap_delta_bytes: heapAfter.heapUsed - heapBefore.heapUsed,
    heap_delta_per_user_bytes: Math.round(
      (heapAfter.heapUsed - heapBefore.heapUsed) / USERS,
    ),
    rss_after_bytes: heapAfter.rss,
    first_user_probe: {
      status: probe.status,
      auth_calls: probeAuth,
      interpretation: probeAuth === 0
        ? "first user's session still in L1 (cache not full)"
        : "first user's session evicted by the bounded L1 (max 5000 entries) — re-verified with one Auth call",
    },
    gc_exposed: Boolean(gc),
    note:
      "memory-only mode (no Upstash): L1 auth cache (max 5000) + rate-limit windows (max 20000: 'ip' + 'user' per user) live in this isolate. heap_delta is only meaningful with --v8-flags=--expose-gc (gc_exposed=true); without it V8 has simply not collected yet.",
  };
  const path = await writeArtifact("load_users.json", result);
  console.log(
    `[stress/load] ${USERS} users in ${result.elapsed_ms}ms heapΔ=${
      (result.heap_delta_bytes / 1_048_576).toFixed(1)
    }MiB auth=${authCalls} probe.auth=${probeAuth} → ${path}`,
  );

  assertEquals(
    result.statuses,
    { "200": USERS },
    "every distinct user must be served 200",
  );
  assertEquals(authCalls, USERS, "one Auth verification per distinct user");
  assertEquals(probe.status, 200);
  if (USERS > 5_000) {
    assertEquals(
      probeAuth,
      1,
      "L1 must be bounded: first of >5000 users is evicted and re-verified",
    );
  } else {
    assertEquals(
      probeAuth,
      0,
      "L1 holds up to 5000 sessions: first user must still be cached",
    );
  }
  // 20k users ⇒ ≤5000 sessions + ≤20000 rate windows retained; anything past
  // ~64 MiB of RETAINED heap means a leak (only measurable after a forced GC).
  if (gc) {
    assert(
      result.heap_delta_bytes < 64 * 1_048_576,
      `heap grew ${result.heap_delta_bytes} bytes`,
    );
  }
  h.dispose();
});

// ── Slug fuzz ────────────────────────────────────────────────────────────────

type SlugClass =
  | "catalog"
  | "catalog_upper"
  | "shape_valid_unknown"
  | "max_len_120"
  | "too_long_121"
  | "bad_first_char"
  | "bad_chars"
  | "unicode"
  | "percent_encoded"
  | "dot_segments"
  | "whitespace"
  | "empty_trailing_slash"
  | "sql_ish"
  | "very_long";

const SLUG_CLASSES: SlugClass[] = [
  "catalog",
  "catalog_upper",
  "shape_valid_unknown",
  "max_len_120",
  "too_long_121",
  "bad_first_char",
  "bad_chars",
  "unicode",
  "percent_encoded",
  "dot_segments",
  "whitespace",
  "empty_trailing_slash",
  "sql_ish",
  "very_long",
];

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_-";
const BAD_CHARS = [
  "/",
  "?",
  "#",
  "%",
  " ",
  ".",
  "'",
  '"',
  ";",
  "\\",
  "<",
  ">",
  "&",
  "=",
  "+",
  "@",
  "!",
  "*",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  "^",
  "`",
  "~",
  ",",
  ":",
];
const rnd = (p: Prng, n: number, alphabet = SLUG_ALPHABET) =>
  Array.from({ length: n }, () => alphabet[p.int(0, alphabet.length - 1)]).join(
    "",
  );

function makeSlug(cls: SlugClass, p: Prng, catalogSlugs: string[]): string {
  const base = p.pick(catalogSlugs);
  switch (cls) {
    case "catalog":
      return base;
    case "catalog_upper":
      return base.replace(
        /[a-z]/g,
        (ch) => (p.next() < 0.5 ? ch.toUpperCase() : ch),
      );
    case "shape_valid_unknown":
      return `${"abcdefghijklmnopqrstuvwxyz0123456789"[p.int(0, 35)]}${
        rnd(p, p.int(0, 40))
      }`;
    case "max_len_120":
      return `z${rnd(p, 119)}`;
    case "too_long_121":
      return `z${rnd(p, 120 + p.int(0, 5))}`;
    case "bad_first_char":
      return `${p.pick(["-", "_"])}${rnd(p, p.int(1, 12))}`;
    case "bad_chars": {
      const body = rnd(p, p.int(3, 12));
      const pos = p.int(1, body.length - 1);
      return body.slice(0, pos) + p.pick(BAD_CHARS) + body.slice(pos);
    }
    case "unicode":
      return p.pick([
        "dink\u00e9",
        "\u30c9\u30ea\u30eb",
        "wall\u200bdink",
        "\ud83e\udd4f-drill",
        "a\u0301b",
        "\ufeffwall-dink-rally",
      ]);
    case "percent_encoded":
      return p.pick([
        encodeURIComponent(base),
        "wall%2Ddink%2Drally",
        "%2e%2e%2fadmin",
        "wall-dink-rally%00",
        "%",
        "%zz",
        "wall%20dink",
        "wall-dink-rally%2F..%2F",
      ]);
    case "dot_segments":
      return p.pick([
        "..",
        ".",
        "...",
        "..%2f..",
        "wall-dink-rally/..",
        "./wall-dink-rally",
      ]);
    case "whitespace":
      return p.pick([
        " ",
        "%20",
        "wall-dink-rally ",
        " wall-dink-rally",
        "wall\tdink",
        "\n",
      ]);
    case "empty_trailing_slash":
      return p.pick(["", "/", "//"]);
    case "sql_ish":
      return p.pick([
        "'; drop table user_saved_drills;--",
        "1 or 1=1",
        "slug' or 'a'='a",
        "*",
        "user_id.eq.x",
      ]);
    case "very_long":
      return rnd(p, p.int(2_000, 9_000));
  }
}

type FuzzRoute = "detail" | "put" | "delete" | "put_then_list";

const EDGE_PREFIX = "/functions/v1/api";

/** The slug the edge will actually see: the WHATWG URL parser has already
 * stripped leading/trailing C0+space and removed tab/newline, and percent-
 * encoded what it must. `segment` is the raw path segment (or null when the
 * path no longer routes to `<route>/<one segment>`), `decoded` its
 * decodeURIComponent (null when that throws → the edge answers 400). */
function effectiveSlug(
  request: Request,
  route: FuzzRoute,
): { segment: string | null; decoded: string | null } {
  const path = new URL(request.url).pathname.slice(EDGE_PREFIX.length);
  const re = route === "detail"
    ? /^\/v1\/catalog\/drills\/([^/]+)$/
    : /^\/v1\/me\/saved-drills\/([^/]+)$/;
  const m = re.exec(path);
  if (!m) return { segment: null, decoded: null };
  try {
    return { segment: m[1], decoded: decodeURIComponent(m[1]) };
  } catch {
    return { segment: m[1], decoded: null };
  }
}

/** What the REAL contract (index.ts routing + drills.ts) says must come back. */
function expectedStatuses(
  route: FuzzRoute,
  eff: { segment: string | null; decoded: string | null },
  catalogSlugs: string[],
): number[] {
  if (eff.segment === null) return [404]; // not `<route>/<one segment>` any more → unknown route
  if (eff.decoded === null) return [400]; // malformed %-escape → "Malformed path segment."
  const shapeValid = /^[a-z0-9][a-z0-9_-]{0,119}$/i.test(eff.decoded);
  if (route === "detail") {
    return catalogSlugs.includes(eff.decoded) ? [200] : [404];
  }
  if (route === "put" || route === "put_then_list") {
    return shapeValid ? [200] : [400];
  }
  // DELETE is an owner-scoped no-op for any single segment: it never shape-checks
  // (an invalid slug cannot exist in the table — CHECK constraint — so nothing
  // is deleted and 204 is the idempotent answer).
  return [204];
}

interface FuzzRow {
  i: number;
  seed: number;
  cls: SlugClass;
  route: FuzzRoute;
  slug: string;
  slug_len: number;
  effective?: string | null;
  status: number;
  code: string | null;
  ms: number;
  rest: number;
  expected: number[];
  ok: boolean;
  leak: boolean;
}

Deno.test(`stress/load: slug fuzz — ${FUZZ} hostile slugs across GET/PUT/DELETE`, async () => {
  const h = await loadStressHarness({ redis: false });
  const catalogSlugs = (await drillCatalog()).map((d) => d.slug);
  const prng = new Prng(STRESS_SEED).fork("slug-fuzz");
  // A fresh user every 60 iterations keeps each under the 240/min general
  // budget (put_then_list spends 3 requests) — the fuzz targets slugs, not 429s.
  const USER_EVERY = 60;
  let token = "";
  let ip = "";
  const rows: FuzzRow[] = [];
  const LEAK = [
    "PGRST",
    "XX000",
    "23514",
    "42501",
    "stack",
    "TypeError",
    "is not a function",
    "supabase.stress.test",
  ];
  for (let i = 0; i < FUZZ; i++) {
    const seed = (prng.seed ^ (i * 2654435761)) >>> 0;
    const step = new Prng(seed);
    const cls = step.pick(SLUG_CLASSES);
    const route = step.pick<FuzzRoute>([
      "detail",
      "put",
      "delete",
      "put_then_list",
    ]);
    const slug = makeSlug(cls, step, catalogSlugs);
    if (i % USER_EVERY === 0) {
      const userPrng = prng.fork(`fuzz-user-${i / USER_EVERY}`);
      token = sessionToken(userPrng.uuid());
      ip = userPrng.ip();
    }
    const mark = h.calls.length;
    let request: Request;
    try {
      request = requestFor(
        route === "put_then_list" ? "put" : route,
        slug,
        token,
        ip,
      );
    } catch (error) {
      // Not even a constructible URL (e.g. raw \n) — nothing reaches the edge.
      rows.push({
        i,
        seed,
        cls,
        route,
        slug,
        slug_len: slug.length,
        status: -1,
        code: `unconstructible:${(error as Error).name}`,
        ms: 0,
        rest: 0,
        expected: [],
        ok: true,
        leak: false,
      });
      continue;
    }
    const { response, stalled, ms, pending } = await answerWithin(
      h.handler,
      request,
      STALL_BUDGET_MS,
    );
    if (stalled) await pending;
    const status = response?.status ?? 0;
    const body = response ? await readJson(response) : {};
    const error = body.error as Record<string, unknown> | undefined;
    const code = typeof error?.code === "string" ? error.code : null;
    const text = JSON.stringify(body);
    const leak = status >= 500 || LEAK.some((m) => text.includes(m));
    const eff = effectiveSlug(request, route);
    const expected = expectedStatuses(route, eff, catalogSlugs);
    let ok = expected.includes(status) && !leak;
    if (route === "put_then_list" && status === 200 && eff.decoded !== null) {
      // A saved slug must not break the saved list or the catalog list, and
      // must come back as exactly the slug the edge saw.
      const list = await h.handler(
        edgeRequest("GET", "/v1/me/saved-drills", { token, ip }),
      );
      const listBody = await readJson(list);
      const items = (listBody.items as Array<{ slug: string }> | undefined) ??
        [];
      const catalogList = await h.handler(
        edgeRequest("GET", "/v1/catalog/drills", { token, ip }),
      );
      await catalogList.body?.cancel();
      const listed = items.some((it) => it.slug === eff.decoded);
      ok = ok && list.status === 200 && listed && catalogList.status === 200;
      if (!ok) {
        console.log(
          `[stress/fuzz] put_then_list broke: list=${list.status} catalog=${catalogList.status} slug=${
            JSON.stringify(eff.decoded)
          } listed=${listed} items=${items.length}`,
        );
      }
    }
    rows.push({
      i,
      seed,
      cls,
      route,
      slug: slug.length > 200 ? `${slug.slice(0, 200)}…(${slug.length})` : slug,
      slug_len: slug.length,
      effective: eff.decoded === null
        ? eff.segment
        : (eff.decoded.length > 200
          ? `${eff.decoded.slice(0, 200)}…`
          : eff.decoded),
      status,
      code,
      ms,
      rest: roundTrips(h, mark).rest,
      expected,
      ok,
      leak,
    });
  }
  const bad = rows.filter((r) => !r.ok);
  const summary = {
    seed: STRESS_SEED,
    iterations: FUZZ,
    executed: rows.filter((r) => r.status >= 0).length,
    unconstructible: rows.filter((r) => r.status === -1).length,
    mismatches: bad.length,
    leaks: rows.filter((r) => r.leak).length,
    five_xx: rows.filter((r) => r.status >= 500).length,
    by_class: Object.fromEntries(
      SLUG_CLASSES.map((cls) => {
        const sub = rows.filter((r) => r.cls === cls);
        return [cls, {
          n: sub.length,
          statuses: histogram(
            sub.map((r) =>
              `${r.route}:${r.status}${r.code ? `/${r.code}` : ""}`
            ),
          ),
          mismatches: sub.filter((r) => !r.ok).length,
        }];
      }),
    ),
    saved_rows_after: h.savedDrills.length,
    saved_slugs_not_in_catalog:
      h.savedDrills.filter((r) => !catalogSlugs.includes(r.slug)).length,
    replay:
      "STRESS_SEED=<seed> STRESS_FUZZ=<n> deno test -A stress_edge_drills_media_load.test.ts; row.seed = fork('slug-fuzz').seed ^ (i*2654435761)",
  };
  const path = await writeArtifact("slug_fuzz.json", {
    summary,
    mismatches: bad,
    rows,
  });
  console.log(
    `[stress/fuzz] ${FUZZ} slugs mismatches=${bad.length} leaks=${summary.leaks} 5xx=${summary.five_xx} orphan-saves=${summary.saved_slugs_not_in_catalog} → ${path}`,
  );
  assertEquals(
    bad.length,
    0,
    `slug fuzz mismatches: ${JSON.stringify(bad.slice(0, 8), null, 1)}`,
  );
  h.dispose();
});
