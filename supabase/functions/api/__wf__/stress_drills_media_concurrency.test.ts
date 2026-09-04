// stress-edge-drills-media / lens CONCURRENCY — Promise.all bursts against the
// REAL edge handler (../index.ts via Deno.serve capture) for the drill
// catalog + instructional-media unit (../drills.ts, ../drillMedia.ts) and the
// routes that consume it:
//   GET    /v1/catalog/drills[?q&family]      GET /v1/catalog/drills/:slug
//   GET    /v1/me/saved-drills                PUT/DELETE /v1/me/saved-drills/:slug
//
// Scenarios (each seeded, each replayable with the `replay` command in its
// JSON report under STRESS_OUT_DIR):
//   C1 catalog/media cold-start race — fresh module instances, concurrent
//      first calls; every result byte-identical, ids deterministic
//   C2 duplicate PUT burst — same user, same slug: idempotent, ONE row
//   C3 PUT/DELETE/GET call-during-call on one (user, slug)
//   C4 two actors on the same slug — RLS isolation, no cross-user effect
//   C5 logout during a burst — fence: nothing starts after the fence
//   C6 refresh rotation during a burst — old bearer keeps working until exp
//   C7 clock skew — bearers with exp around now: 401 iff expired, never 5xx
//   C8 slug fuzz under concurrency — PUT/GET/DELETE of hostile slugs
//   REPRO (defect) — deterministic interleavings of the defects the campaign
//      classified (PUT/DELETE read-back race → 503; prototype-key slugs throw
//      inside drillInstructionalMedia)
//
// Every invariant is the CONTRACT (route comments in ../index.ts, AGENTS.md);
// a failing invariant here reproduces a live defect on the tree under test.
// The one defect the campaign found (PUT_DELETE_RACE) is classified: its
// invariants are recorded as BROKEN/known in the JSON (with every explained
// 5xx) and pinned by the deterministic REPRO test, so the suite stays green
// until the route is fixed — at which point the REPRO test flips.
// Default scale runs > 500 handler requests in a few seconds; STRESS_ITER=N
// multiplies the rounds.

import { assert, assertEquals } from "@std/assert";
import {
  bootstrap,
  edgeRequest,
  histogram,
  loadXcHarness,
  Prng,
  sleep,
  type XcHarness,
} from "./xc_concurrency_harness.ts";
import {
  burst,
  DeadlineExceeded,
  expectedPutStatus,
  fnv1a,
  fuzzSlugs,
  installSavedDrillsTable,
  inv,
  no5xx,
  PUT_DELETE_RACE,
  replay,
  type Row,
  type SavedDrillRow,
  segmentNormalizesAway,
  split5xx,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_SEED,
  stressHooks,
  type StressInvariant,
  stressOutDir,
  type StressReport,
  timed,
  writeStressReport,
} from "./stress_drills_media_harness.ts";

const FILE = "stress_drills_media_concurrency.test.ts";
const ROUNDS = 3 * STRESS_ITER;

let scenarioHash = 0;
const usedPrefixes = new Map<number, string>();
const ip = (round: number, lane: number) =>
  `10.${scenarioHash & 255}.${
    (((scenarioHash >> 8) & 15) << 4) | (round & 15)
  }.${lane & 255}`;

const reports: StressReport[] = [];

async function scenario(
  name: string,
  filter: string,
  scale: Record<string, number>,
  run: (
    h: XcHarness,
    prng: Prng,
    rows: Row[],
    invariants: StressInvariant[],
    inputs: Record<string, unknown>,
    observations: Record<string, unknown>,
  ) => Promise<void>,
): Promise<StressReport> {
  const h = await loadXcHarness();
  installSavedDrillsTable(h);
  scenarioHash = fnv1a(name);
  const prefix = scenarioHash & 0xfff;
  const clash = usedPrefixes.get(prefix);
  if (clash && clash !== name) {
    throw new Error(
      `stress: IP prefix clash between ${clash} and ${name} — rename one`,
    );
  }
  usedPrefixes.set(prefix, name);
  const seed = STRESS_SEED;
  h.fake.reset(seed, STRESS_LATENCY_MS);
  h.upstreamCalls.length = 0;
  const prng = new Prng((seed ^ scenarioHash) >>> 0);
  const rows: Row[] = [];
  const invariants: StressInvariant[] = [];
  const inputs: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  try {
    await run(h, prng, rows, invariants, inputs, observations);
  } catch (error) {
    if (error instanceof DeadlineExceeded) {
      inv(invariants, "bounded wall time (no deadlock)", false, error.message);
    } else {
      throw error;
    }
  }
  const durationMs = Math.round(performance.now() - t0);
  const after = Deno.memoryUsage();
  const report: StressReport = {
    scenario: name,
    seed,
    scale,
    inputs,
    statusHistogram: histogram(
      rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`),
    ),
    counters: { ...h.fake.counters },
    invariants,
    observations,
    requests: rows.length,
    durationMs,
    heap: { before, after },
    replay: replay(FILE, filter, seed),
    rows,
  };
  const path = await writeStressReport(report);
  reports.push(report);
  console.log(
    `[stress] ${name}: ${rows.length} requests in ${durationMs}ms → ${path}`,
  );
  for (const i of invariants) {
    const verdict = i.holds
      ? "HELD  "
      : i.known
      ? `BROKEN(known:${i.known})`
      : "BROKEN";
    console.log(`[stress]   ${verdict} ${i.name} — ${i.detail}`);
  }
  return report;
}

function assertReport(report: StressReport): void {
  for (const i of report.invariants) {
    if (i.known) continue;
    assert(i.holds, `${report.scenario}: ${i.name}: ${i.detail}`);
  }
}

/** 5xx bookkeeping shared by every scenario that races PUT against DELETE:
 * explained 503s are the classified defect (known), anything else fails. */
function fiveXxInvariants(
  invariants: StressInvariant[],
  rows: Row[],
  observations: Record<string, unknown>,
): void {
  const { explained, unexplained } = split5xx(rows);
  observations.knownRace503 = explained.length;
  observations.knownRace503Rows = explained.map((r) => ({
    round: r.round,
    i: r.i,
    op: r.op,
    tag: r.tag,
  }));
  inv(
    invariants,
    "no 5xx",
    no5xx(rows).length === 0,
    `${
      no5xx(rows).length
    } 5xx (${explained.length} explained by ${PUT_DELETE_RACE}, ${unexplained.length} unexplained)`,
    unexplained.length === 0 ? PUT_DELETE_RACE : undefined,
  );
  inv(
    invariants,
    "no 5xx other than the classified PUT/DELETE read-back race",
    unexplained.length === 0,
    `${unexplained.length} unexplained: ${
      JSON.stringify(unexplained.slice(0, 5))
    }`,
  );
}

const savedRows = (h: XcHarness) =>
  h.fake.tables.user_saved_drills as SavedDrillRow[];

function stripSaved(body: Record<string, unknown>): string {
  const drill = { ...(body.drill as Record<string, unknown>) };
  delete drill.saved;
  return JSON.stringify({ ...body, drill });
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — cold-start race on the module-level catalog cache + media determinism
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C1: concurrent first calls on fresh drills.ts/drillMedia.ts instances agree byte-for-byte; ids deterministic",
  async () => {
    const report = await scenario(
      "c1_catalog_media_cold_start",
      "stress C1",
      { rounds: ROUNDS, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        type DrillsMod = typeof import("../drills.ts");
        type MediaMod = typeof import("../drillMedia.ts");
        const canonical: DrillsMod = await import("../drills.ts");
        const canonicalMedia: MediaMod = await import("../drillMedia.ts");
        const refCatalog = JSON.stringify(await canonical.drillCatalog());
        const slugs = (await canonical.drillCatalog()).map((d) => d.slug);
        const refMedia = new Map<string, string>();
        for (const slug of slugs) {
          refMedia.set(
            slug,
            JSON.stringify(await canonicalMedia.drillInstructionalMedia(slug)),
          );
        }
        inputs.slugs = slugs.length;
        let pureCalls = 0;
        let mismatches = 0;
        let idCollisions = 0;
        for (let r = 0; r < ROUNDS; r++) {
          // A fresh module instance per round → `cachedCatalog` is null again,
          // so the burst below genuinely races the lazy initialiser.
          const fresh: DrillsMod = await import(
            `../drills.ts?stress=${STRESS_SEED}-${r}`
          );
          const freshMedia: MediaMod = await import(
            `../drillMedia.ts?stress=${STRESS_SEED}-${r}`
          );
          const lanes = Array.from({ length: STRESS_BURST }, (_, i) => i);
          const results = await burst(
            `C1 round ${r}`,
            lanes.map(async (i) => {
              await sleep(prng.int(0, 2));
              const kind = i % 4;
              const slug = slugs[prng.int(0, slugs.length - 1)];
              pureCalls += 1;
              if (kind === 0) {
                return ["catalog", JSON.stringify(await fresh.drillCatalog())];
              }
              if (kind === 1) {
                return [
                  `entry:${slug}`,
                  JSON.stringify(await fresh.drillCatalogEntry(slug)),
                ];
              }
              if (kind === 2) {
                const q =
                  ["dink", "wall", "reset", "", "volley"][prng.int(0, 4)];
                return [
                  `search:${q}`,
                  JSON.stringify(await fresh.searchDrillCatalog({ q })),
                ];
              }
              return [
                `media:${slug}`,
                JSON.stringify(await freshMedia.drillInstructionalMedia(slug)),
              ];
            }),
          );
          const refCatalogArr = JSON.parse(refCatalog) as Array<
            Record<string, unknown>
          >;
          for (const [kind, json] of results) {
            let expected: string;
            if (kind === "catalog") expected = refCatalog;
            else if (kind.startsWith("entry:")) {
              expected = JSON.stringify(
                refCatalogArr.find((d) => d.slug === kind.slice(6)) ?? null,
              );
            } else if (kind.startsWith("search:")) {
              expected = JSON.stringify(
                await canonical.searchDrillCatalog({ q: kind.slice(7) }),
              );
            } else expected = refMedia.get(kind.slice(6))!;
            if (json !== expected) mismatches += 1;
          }
          // Media ids must be unique per (slug, video) and stable across instances.
          const seen = new Map<string, string>();
          for (const slug of slugs) {
            for (const m of await freshMedia.drillInstructionalMedia(slug)) {
              pureCalls += 1;
              const key = `${slug}:${m.videoId}`;
              const prev = seen.get(m.id);
              if (prev && prev !== key) idCollisions += 1;
              seen.set(m.id, key);
            }
          }
          // The real route over the same instance-free path: a burst of detail
          // GETs from a fresh user must all equal the canonical body (minus `saved`).
          const session = await bootstrap(h, prng.uuid(), ip(r, 250));
          const detail = await burst(
            `C1 detail burst ${r}`,
            lanes.map((i) =>
              timed(rows, r, i, "catalog.detail", () =>
                h.handler(
                  edgeRequest(
                    "GET",
                    `/v1/catalog/drills/${slugs[i % slugs.length]}`,
                    {
                      token: session.accessToken,
                      ip: ip(r, i),
                    },
                  ),
                ))
            ),
          );
          const refBodies = new Map<string, string>();
          for (const res of detail) {
            const slug = String(
              (res.body.drill as Record<string, unknown>)?.slug,
            );
            const body = stripSaved(res.body);
            const prev = refBodies.get(slug);
            if (prev === undefined) refBodies.set(slug, body);
            else if (prev !== body) mismatches += 1;
            const media = JSON.stringify(res.body.instructionalMedia);
            if (media !== refMedia.get(slug)) mismatches += 1;
          }
        }
        observations.pureCalls = pureCalls;
        observations.mismatches = mismatches;
        inv(
          invariants,
          "every concurrent cold-start result equals the canonical module",
          mismatches === 0,
          `${mismatches} mismatches over ${pureCalls} pure calls + ${rows.length} requests`,
        );
        inv(
          invariants,
          "media ids never collide across (slug, video)",
          idCollisions === 0,
          `${idCollisions} collisions`,
        );
        inv(
          invariants,
          "every detail GET is 200",
          rows.every((r) => r.status === 200),
          JSON.stringify(histogram(rows.map((r) => r.status))),
        );
        inv(
          invariants,
          "no 5xx",
          no5xx(rows).length === 0,
          `${no5xx(rows).length} 5xx`,
        );
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C2 — duplicate PUT burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C2: duplicate PUT /v1/me/saved-drills/:slug burst — every call 200, ONE row, one saved_at",
  async () => {
    const report = await scenario(
      "c2_duplicate_put_burst",
      "stress C2",
      { rounds: ROUNDS, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        let savedAtVariants = 0;
        let rowsPerUserBad = 0;
        for (let r = 0; r < ROUNDS; r++) {
          const sub = prng.uuid();
          users.push(sub);
          const session = await bootstrap(h, sub, ip(r, 250));
          const slug =
            ["wall-dink-rally", "skinny-singles", "dink-target-boxes"][r % 3];
          const results = await burst(
            `C2 round ${r}`,
            Array.from(
              { length: STRESS_BURST },
              (_, i) =>
                timed(rows, r, i, "put", () =>
                  h.handler(
                    edgeRequest("PUT", `/v1/me/saved-drills/${slug}`, {
                      token: session.accessToken,
                      ip: ip(r, i),
                    }),
                  )),
            ),
          );
          const savedAts = new Set(
            results.filter((x) => x.status === 200).map((x) =>
              String(x.body.savedAt)
            ),
          );
          if (savedAts.size !== 1) savedAtVariants += 1;
          const mine = savedRows(h).filter((row) => row.user_id === sub);
          if (mine.length !== 1 || mine[0].slug !== slug) rowsPerUserBad += 1;
          // read-your-writes across the whole surface
          const [list, detail, catalog] = await burst(`C2 verify ${r}`, [
            timed(
              rows,
              r,
              0,
              "list",
              () =>
                h.handler(
                  edgeRequest("GET", "/v1/me/saved-drills", {
                    token: session.accessToken,
                    ip: ip(r, 251),
                  }),
                ),
            ),
            timed(
              rows,
              r,
              1,
              "detail",
              () =>
                h.handler(
                  edgeRequest("GET", `/v1/catalog/drills/${slug}`, {
                    token: session.accessToken,
                    ip: ip(r, 252),
                  }),
                ),
            ),
            timed(
              rows,
              r,
              2,
              "catalog",
              () =>
                h.handler(
                  edgeRequest("GET", "/v1/catalog/drills", {
                    token: session.accessToken,
                    ip: ip(r, 253),
                  }),
                ),
            ),
          ]);
          const listItems =
            (list.body.items as Array<Record<string, unknown>>) ?? [];
          const detailSaved = (detail.body.drill as Record<string, unknown>)
            ?.saved;
          const catalogSaved =
            ((catalog.body.items as Array<Record<string, unknown>>) ?? [])
              .filter((d) => d.saved).map((d) => d.slug);
          inv(
            invariants,
            `round ${r}: read-your-writes — list has exactly [${slug}], detail.saved, catalog marks exactly one`,
            listItems.length === 1 && listItems[0].slug === slug &&
              detailSaved === true && catalogSaved.length === 1 &&
              catalogSaved[0] === slug,
            `list=${
              JSON.stringify(listItems.map((i) => i.slug))
            } detail.saved=${String(detailSaved)} catalog.saved=${
              JSON.stringify(catalogSaved)
            }`,
          );
        }
        inputs.users = users;
        observations.rows = savedRows(h).length;
        observations.upserts = h.fake.counters["rest.post.user_saved_drills"] ??
          0;
        const puts = rows.filter((r) => r.op === "put");
        inv(
          invariants,
          "every duplicate PUT returns 200 {saved:true}",
          puts.every((r) => r.status === 200),
          JSON.stringify(histogram(puts.map((r) => r.status))),
        );
        inv(
          invariants,
          "exactly one row per (user, slug) after the burst",
          rowsPerUserBad === 0 && savedRows(h).length === ROUNDS,
          `${savedRows(h).length} rows for ${ROUNDS} users`,
        );
        inv(
          invariants,
          "one saved_at per user across all duplicates (idempotent, first write wins)",
          savedAtVariants === 0,
          `${savedAtVariants} rounds with >1 savedAt`,
        );
        inv(
          invariants,
          "no 5xx",
          no5xx(rows).length === 0,
          `${no5xx(rows).length} 5xx`,
        );
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C3 — PUT / DELETE / GET call-during-call on one (user, slug)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C3: interleaved PUT/DELETE/GET on one (user, slug) — rows ∈ {0,1}, PUT→200, DELETE→204, no 5xx, final reads agree",
  async () => {
    const report = await scenario(
      "c3_put_delete_interleave",
      "stress C3",
      { rounds: ROUNDS * 2, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        let rowCountBad = 0;
        let finalDisagree = 0;
        const putNon200: Array<Record<string, unknown>> = [];
        for (let r = 0; r < ROUNDS * 2; r++) {
          const sub = prng.uuid();
          users.push(sub);
          const session = await bootstrap(h, sub, ip(r, 250));
          const slug = "wall-dink-rally";
          const ops = prng.shuffle(
            Array.from(
              { length: STRESS_BURST },
              (_, i) => ["put", "put", "delete", "detail", "list"][i % 5],
            ),
          );
          const results = await burst(
            `C3 round ${r}`,
            ops.map((op, i) =>
              timed(rows, r, i, op, () => {
                const token = session.accessToken;
                if (op === "put") {
                  return h.handler(
                    edgeRequest("PUT", `/v1/me/saved-drills/${slug}`, {
                      token,
                      ip: ip(r, i),
                    }),
                  );
                }
                if (op === "delete") {
                  return h.handler(
                    edgeRequest("DELETE", `/v1/me/saved-drills/${slug}`, {
                      token,
                      ip: ip(r, i),
                    }),
                  );
                }
                if (op === "detail") {
                  return h.handler(
                    edgeRequest("GET", `/v1/catalog/drills/${slug}`, {
                      token,
                      ip: ip(r, i),
                    }),
                  );
                }
                return h.handler(
                  edgeRequest("GET", "/v1/me/saved-drills", {
                    token,
                    ip: ip(r, i),
                  }),
                );
              }, `${sub}:${slug}`)
            ),
          );
          results.forEach((res, i) => {
            if (ops[i] === "put" && res.status !== 200) {
              putNon200.push({
                round: r,
                lane: i,
                status: res.status,
                body: res.body,
                seed: STRESS_SEED,
              });
            }
          });
          const mine = savedRows(h).filter((row) => row.user_id === sub);
          if (mine.length > 1) rowCountBad += 1;
          const [detail, list] = await burst(`C3 verify ${r}`, [
            timed(
              rows,
              r,
              0,
              "final.detail",
              () =>
                h.handler(
                  edgeRequest("GET", `/v1/catalog/drills/${slug}`, {
                    token: session.accessToken,
                    ip: ip(r, 251),
                  }),
                ),
            ),
            timed(
              rows,
              r,
              1,
              "final.list",
              () =>
                h.handler(
                  edgeRequest("GET", "/v1/me/saved-drills", {
                    token: session.accessToken,
                    ip: ip(r, 252),
                  }),
                ),
            ),
          ]);
          const detailSaved =
            (detail.body.drill as Record<string, unknown>)?.saved === true;
          const listHas =
            ((list.body.items as Array<Record<string, unknown>>) ?? []).some((
              i,
            ) => i.slug === slug);
          if (
            detailSaved !== (mine.length === 1) ||
            listHas !== (mine.length === 1)
          ) finalDisagree += 1;
        }
        inputs.users = users;
        observations.putNon200 = putNon200;
        observations.rows = savedRows(h).length;
        const puts = rows.filter((r) => r.op === "put");
        const dels = rows.filter((r) => r.op === "delete");
        const gets = rows.filter((r) => r.op === "detail" || r.op === "list");
        const { unexplained } = split5xx(rows);
        inv(
          invariants,
          "rows per (user, slug) never exceed 1",
          rowCountBad === 0,
          `${rowCountBad} rounds with duplicates`,
        );
        inv(
          invariants,
          "every PUT racing a DELETE on its own slug still returns 200 {saved:true} (PUT is an idempotent upsert; 5xx is reserved for upstream failure)",
          puts.every((r) => r.status === 200),
          JSON.stringify(histogram(puts.map((r) => r.status))),
          puts.every((r) =>
              r.status === 200 || (r.status === 503 && !unexplained.includes(r))
            )
            ? PUT_DELETE_RACE
            : undefined,
        );
        inv(
          invariants,
          "every DELETE returns 204",
          dels.every((r) => r.status === 204),
          JSON.stringify(histogram(dels.map((r) => r.status))),
        );
        inv(
          invariants,
          "every GET returns 200",
          gets.every((r) => r.status === 200),
          JSON.stringify(histogram(gets.map((r) => r.status))),
        );
        inv(
          invariants,
          "final detail.saved and list agree with the table",
          finalDisagree === 0,
          `${finalDisagree} disagreements`,
        );
        fiveXxInvariants(invariants, rows, observations);
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C4 — two actors on the same slug
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C4: two users race PUT/DELETE on the same slugs — owner-only rows, no cross-user reads or deletes",
  async () => {
    const report = await scenario(
      "c4_two_actors_same_slug",
      "stress C4",
      { rounds: ROUNDS, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        const slugs = [
          "wall-dink-rally",
          "skinny-singles",
          "figure-eight-dinks",
        ];
        let crossUser = 0;
        let leakedRows = 0;
        let wrongOwnerVisible = 0;
        const pairs: string[][] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const subA = prng.uuid();
          const subB = prng.uuid();
          pairs.push([subA, subB]);
          const [a, b] = await Promise.all([
            bootstrap(h, subA, ip(r, 250)),
            bootstrap(h, subB, ip(r, 249)),
          ]);
          // A saves everything; B saves then deletes the same slugs — B's
          // deletes must never touch A's rows.
          const lanes = Array.from({ length: STRESS_BURST }, (_, i) => {
            const slug = slugs[i % slugs.length];
            const who = i % 2 === 0 ? "A" : "B";
            const op = who === "A" ? "put" : ["put", "delete"][(i >> 1) % 2];
            return { who, op, slug };
          });
          await burst(
            `C4 round ${r}`,
            prng.shuffle(lanes).map((lane, i) =>
              timed(rows, r, i, `${lane.who}.${lane.op}`, () =>
                h.handler(
                  edgeRequest(
                    lane.op === "put" ? "PUT" : "DELETE",
                    `/v1/me/saved-drills/${lane.slug}`,
                    {
                      token: lane.who === "A" ? a.accessToken : b.accessToken,
                      ip: ip(r, i),
                    },
                  ),
                ), `${lane.who}:${lane.slug}`)
            ),
          );
          const rowsA = savedRows(h).filter((row) => row.user_id === subA);
          const rowsB = savedRows(h).filter((row) => row.user_id === subB);
          if (rowsA.length !== slugs.length) leakedRows += 1;
          if (rowsB.length > slugs.length) leakedRows += 1;
          const [listA, listB, catB] = await burst(`C4 verify ${r}`, [
            timed(
              rows,
              r,
              0,
              "A.list",
              () =>
                h.handler(
                  edgeRequest("GET", "/v1/me/saved-drills", {
                    token: a.accessToken,
                    ip: ip(r, 251),
                  }),
                ),
            ),
            timed(
              rows,
              r,
              1,
              "B.list",
              () =>
                h.handler(
                  edgeRequest("GET", "/v1/me/saved-drills", {
                    token: b.accessToken,
                    ip: ip(r, 252),
                  }),
                ),
            ),
            timed(
              rows,
              r,
              2,
              "B.catalog",
              () =>
                h.handler(
                  edgeRequest("GET", "/v1/catalog/drills", {
                    token: b.accessToken,
                    ip: ip(r, 253),
                  }),
                ),
            ),
          ]);
          const aSlugs =
            ((listA.body.items as Array<Record<string, unknown>>) ?? []).map((
              i,
            ) => String(i.slug)).sort();
          const bSlugs =
            ((listB.body.items as Array<Record<string, unknown>>) ?? []).map((
              i,
            ) => String(i.slug)).sort();
          if (JSON.stringify(aSlugs) !== JSON.stringify([...slugs].sort())) {
            crossUser += 1;
          }
          if (
            JSON.stringify(bSlugs) !== JSON.stringify(
              rowsB.map((x) => x.slug).sort(),
            )
          ) crossUser += 1;
          const bCatalogSaved =
            ((catB.body.items as Array<Record<string, unknown>>) ?? []).filter((
              d,
            ) => d.saved).map((d) => String(d.slug)).sort();
          if (JSON.stringify(bCatalogSaved) !== JSON.stringify(bSlugs)) {
            wrongOwnerVisible += 1;
          }
        }
        inputs.pairs = pairs;
        observations.rows = savedRows(h).length;
        inv(
          invariants,
          "A keeps every slug regardless of B's deletes (no cross-user delete)",
          leakedRows === 0,
          `${leakedRows} rounds with wrong row counts`,
        );
        inv(
          invariants,
          "each user's list is exactly their own rows",
          crossUser === 0,
          `${crossUser} mismatches`,
        );
        inv(
          invariants,
          "catalog `saved` flags follow the caller, not the other actor",
          wrongOwnerVisible === 0,
          `${wrongOwnerVisible} mismatches`,
        );
        const writes = rows.filter((r) =>
          r.op.endsWith(".put") || r.op.endsWith(".delete")
        );
        const aWrites = writes.filter((r) => r.op.startsWith("A."));
        inv(
          invariants,
          "A (who never deletes) gets 200 on every PUT — B's deletes never disturb A",
          aWrites.every((r) => r.status === 200),
          JSON.stringify(histogram(aWrites.map((r) => r.status))),
        );
        const { unexplained } = split5xx(rows);
        inv(
          invariants,
          "every write is 200/204",
          writes.every((r) => r.status === 200 || r.status === 204),
          JSON.stringify(histogram(writes.map((r) => `${r.op}:${r.status}`))),
          writes.every((r) =>
              r.status === 200 || r.status === 204 ||
              (r.status === 503 && !unexplained.includes(r))
            )
            ? PUT_DELETE_RACE
            : undefined,
        );
        fiveXxInvariants(invariants, rows, observations);
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C5 — logout during a burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C5: logout while saved-drill writes are in flight — nothing that starts after the fence succeeds, no 5xx",
  async () => {
    const report = await scenario(
      "c5_logout_during_burst",
      "stress C5",
      { rounds: ROUNDS, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        let afterFenceOk = 0;
        let afterFenceWrites = 0;
        let postLogoutOk = 0;
        const users: string[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const sub = prng.uuid();
          users.push(sub);
          const session = await bootstrap(h, sub, ip(r, 250));
          // warm the auth cache exactly like a live device would have
          await timed(
            rows,
            r,
            254,
            "warm",
            () =>
              h.handler(
                edgeRequest("GET", "/v1/me/saved-drills", {
                  token: session.accessToken,
                  ip: ip(r, 254),
                }),
              ),
          );
          const logoutAt = prng.int(2, STRESS_BURST - 2);
          h.fake.overrides.logoutDelayMs = prng.int(0, STRESS_LATENCY_MS * 2);
          let logoutEnd = Infinity;
          const lanes = Array.from({ length: STRESS_BURST }, (_, i) => i);
          const results = await burst(
            `C5 round ${r}`,
            lanes.map(async (i) => {
              await sleep(prng.int(0, STRESS_LATENCY_MS * 3));
              if (i === logoutAt) {
                const res = await timed(
                  rows,
                  r,
                  i,
                  "logout",
                  () =>
                    h.handler(
                      edgeRequest("POST", "/v1/auth/logout", {
                        token: session.accessToken,
                        ip: ip(r, i),
                      }),
                    ),
                );
                logoutEnd = res.row.endedAt;
                return res;
              }
              const slug = ["wall-dink-rally", "skinny-singles"][i % 2];
              return timed(
                rows,
                r,
                i,
                i % 3 === 0 ? "delete" : "put",
                () =>
                  h.handler(
                    edgeRequest(
                      i % 3 === 0 ? "DELETE" : "PUT",
                      `/v1/me/saved-drills/${slug}`,
                      { token: session.accessToken, ip: ip(r, i) },
                    ),
                  ),
                `${sub}:${slug}`,
              );
            }),
          );
          const writesBefore = h.fake.counters["rest.post.user_saved_drills"] ??
            0;
          for (const res of results) {
            if (res.row.op === "logout") continue;
            if (res.row.startedAt > logoutEnd && res.status !== 401) {
              afterFenceOk += 1;
            }
          }
          // Every request after the burst must be refused, and must not write.
          const after = await burst(
            `C5 after ${r}`,
            lanes.slice(0, 6).map((i) =>
              timed(
                rows,
                r,
                i,
                "after.put",
                () =>
                  h.handler(
                    edgeRequest("PUT", `/v1/me/saved-drills/skinny-singles`, {
                      token: session.accessToken,
                      ip: ip(r, 200 + i),
                    }),
                  ),
              )
            ),
          );
          postLogoutOk += after.filter((x) => x.status !== 401).length;
          afterFenceWrites +=
            (h.fake.counters["rest.post.user_saved_drills"] ?? 0) -
            writesBefore;
        }
        h.fake.overrides.logoutDelayMs = undefined;
        inputs.users = users;
        observations.rows = savedRows(h).length;
        const inflight = rows.filter((r) =>
          r.op === "put" || r.op === "delete"
        );
        const { unexplained } = split5xx(rows);
        inv(
          invariants,
          "in-flight writes settle as 200/204 or 401 only",
          inflight.every((r) => [200, 204, 401].includes(r.status)),
          JSON.stringify(histogram(inflight.map((r) => `${r.op}:${r.status}`))),
          inflight.every((r) =>
              [200, 204, 401].includes(r.status) ||
              (r.status === 503 && !unexplained.includes(r))
            )
            ? PUT_DELETE_RACE
            : undefined,
        );
        inv(
          invariants,
          "every logout returns 204",
          rows.filter((r) => r.op === "logout").every((r) => r.status === 204),
          JSON.stringify(
            histogram(
              rows.filter((r) => r.op === "logout").map((r) => r.status),
            ),
          ),
        );
        inv(
          invariants,
          "no request that STARTED after the fence was published succeeds",
          afterFenceOk === 0,
          `${afterFenceOk} post-fence successes`,
        );
        inv(
          invariants,
          "after the burst the revoked bearer is refused and writes nothing",
          postLogoutOk === 0 && afterFenceWrites === 0,
          `${postLogoutOk} non-401, ${afterFenceWrites} upserts`,
        );
        fiveXxInvariants(invariants, rows, observations);
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C6 — refresh rotation during a burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C6: refresh rotates the session while saved-drill requests are in flight — old bearer keeps working until exp, new bearer works, one row per slug",
  async () => {
    const report = await scenario(
      "c6_refresh_during_burst",
      "stress C6",
      { rounds: ROUNDS, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        let newTokenFailures = 0;
        let rowsBad = 0;
        for (let r = 0; r < ROUNDS; r++) {
          const sub = prng.uuid();
          users.push(sub);
          const session = await bootstrap(h, sub, ip(r, 250));
          const refreshAt = prng.int(1, STRESS_BURST - 2);
          let rotated = "";
          const slugs = [
            "wall-dink-rally",
            "skinny-singles",
            "dink-target-boxes",
            "figure-eight-dinks",
          ];
          await burst(
            `C6 round ${r}`,
            Array.from({ length: STRESS_BURST }, async (_, i) => {
              await sleep(prng.int(0, STRESS_LATENCY_MS * 2));
              if (i === refreshAt) {
                const res = await timed(
                  rows,
                  r,
                  i,
                  "refresh",
                  () =>
                    h.handler(
                      edgeRequest("POST", "/v1/auth/refresh", {
                        ip: ip(r, i),
                        body: { refreshToken: session.refreshToken },
                      }),
                    ),
                );
                rotated = String(
                  (res.body.session as Record<string, unknown>)?.accessToken ??
                    "",
                );
                return res;
              }
              return timed(
                rows,
                r,
                i,
                "old.put",
                () =>
                  h.handler(
                    edgeRequest(
                      "PUT",
                      `/v1/me/saved-drills/${slugs[i % slugs.length]}`,
                      { token: session.accessToken, ip: ip(r, i) },
                    ),
                  ),
              );
            }),
          );
          const withNew = await burst(
            `C6 new-token ${r}`,
            slugs.map((slug, i) =>
              timed(
                rows,
                r,
                i,
                "new.detail",
                () =>
                  h.handler(
                    edgeRequest("GET", `/v1/catalog/drills/${slug}`, {
                      token: rotated,
                      ip: ip(r, 200 + i),
                    }),
                  ),
              )
            ),
          );
          newTokenFailures += withNew.filter((x) =>
            x.status !== 200 ||
            (x.body.drill as Record<string, unknown>)?.saved !== true
          ).length;
          const mine = savedRows(h).filter((row) => row.user_id === sub);
          if (
            mine.length !== slugs.length ||
            new Set(mine.map((m) => m.slug)).size !== slugs.length
          ) rowsBad += 1;
        }
        inputs.users = users;
        observations.rows = savedRows(h).length;
        const old = rows.filter((r) => r.op === "old.put");
        inv(
          invariants,
          "every PUT with the pre-rotation bearer is 200 (access token valid until exp)",
          old.every((r) => r.status === 200),
          JSON.stringify(histogram(old.map((r) => r.status))),
        );
        inv(
          invariants,
          "every refresh is 200",
          rows.filter((r) => r.op === "refresh").every((r) => r.status === 200),
          JSON.stringify(
            histogram(
              rows.filter((r) => r.op === "refresh").map((r) => r.status),
            ),
          ),
        );
        inv(
          invariants,
          "the rotated bearer sees the writes made under the old one",
          newTokenFailures === 0,
          `${newTokenFailures} failures`,
        );
        inv(
          invariants,
          "exactly one row per slug per user",
          rowsBad === 0,
          `${rowsBad} rounds off`,
        );
        inv(
          invariants,
          "no 5xx",
          no5xx(rows).length === 0,
          `${no5xx(rows).length} 5xx`,
        );
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C7 — clock skew
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C7: bearers whose exp straddles now (client/server clock skew) — 401 iff expired, otherwise served, never 5xx",
  async () => {
    const report = await scenario(
      "c7_clock_skew",
      "stress C7",
      { rounds: ROUNDS, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        let misclassified = 0;
        const skews: number[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const sub = prng.uuid();
          // Provider ID tokens carry their own exp; the edge fn refuses an
          // expired one before any upstream call (bearerExpired). Skew ± 120s.
          const lanes = Array.from({ length: STRESS_BURST }, (_, i) => {
            const skewSeconds = prng.int(-120, 120);
            skews.push(skewSeconds);
            const exp = Math.floor(Date.now() / 1000) + skewSeconds;
            const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
              .replace(/=+$/, "");
            const payload = btoa(
              JSON.stringify({
                iss: "https://accounts.google.com",
                sub,
                exp,
                nonce: `${r}-${i}`,
              }),
            )
              .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            // exp is whole seconds: skew ≤ 0 is already expired, skew ≥ 2 stays
            // live for the whole burst; skew 1 is ambiguous by construction.
            return {
              token: `${header}.${payload}.sig`,
              skewSeconds,
              expired: skewSeconds <= 0,
            };
          });
          const results = await burst(
            `C7 round ${r}`,
            lanes.map((lane, i) =>
              timed(
                rows,
                r,
                i,
                lane.expired ? "expired.detail" : "live.detail",
                () =>
                  h.handler(
                    edgeRequest("GET", "/v1/catalog/drills/wall-dink-rally", {
                      token: lane.token,
                      ip: ip(r, i),
                    }),
                  ),
              )
            ),
          );
          results.forEach((res, i) => {
            const lane = lanes[i];
            if (lane.skewSeconds === 1) return;
            if (lane.expired && res.status !== 401) misclassified += 1;
            if (!lane.expired && res.status !== 200) misclassified += 1;
          });
        }
        inputs.skewSeconds = histogram(
          skews.map((s) => (s <= 0 ? "expired" : s < 60 ? "<60s" : "≥60s")),
        );
        observations.exchanges = h.fake.counters["gotrue.token.id_token"] ?? 0;
        inv(
          invariants,
          "expired bearers are 401 and live bearers are 200 (no skew-dependent 5xx)",
          misclassified === 0,
          `${misclassified} misclassified; ${
            JSON.stringify(histogram(rows.map((r) => `${r.op}:${r.status}`)))
          }`,
        );
        inv(
          invariants,
          "no 5xx",
          no5xx(rows).length === 0,
          `${no5xx(rows).length} 5xx`,
        );
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C8 — slug fuzz under concurrency
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress C8: hostile slugs fuzzed concurrently across PUT/GET/DELETE — oracle statuses, no 5xx, only shape-valid slugs persist",
  async () => {
    const report = await scenario(
      "c8_slug_fuzz_burst",
      "stress C8",
      { rounds: ROUNDS, burst: STRESS_BURST },
      async (h, prng, rows, invariants, inputs, observations) => {
        const canonical = await import("../drills.ts");
        const catalog = new Set(
          (await canonical.drillCatalog()).map((d) => d.slug),
        );
        const surprises: Array<Record<string, unknown>> = [];
        let persistedInvalid = 0;
        const corpus = fuzzSlugs(prng, ROUNDS * STRESS_BURST);
        inputs.corpusKinds = histogram(corpus.map((c) => c.kind));
        inputs.corpus = corpus.map((c) => ({ id: c.id, wire: c.wire }));
        for (let r = 0; r < ROUNDS; r++) {
          const sub = prng.uuid();
          const session = await bootstrap(h, sub, ip(r, 250));
          const slice = corpus.slice(r * STRESS_BURST, (r + 1) * STRESS_BURST);
          const lanes = slice.flatMap((slug, i) => [
            { slug, op: "put", i: i * 3 },
            { slug, op: "detail", i: i * 3 + 1 },
            { slug, op: "delete", i: i * 3 + 2 },
          ]);
          const results = await burst(
            `C8 round ${r}`,
            prng.shuffle(lanes).map((lane) =>
              timed(rows, r, lane.i, `${lane.slug.kind}.${lane.op}`, () => {
                const path = lane.op === "detail"
                  ? `/v1/catalog/drills/${lane.slug.wire}`
                  : `/v1/me/saved-drills/${lane.slug.wire}`;
                const method = lane.op === "put"
                  ? "PUT"
                  : lane.op === "delete"
                  ? "DELETE"
                  : "GET";
                return h.handler(
                  edgeRequest(method, path, {
                    token: session.accessToken,
                    ip: ip(r, lane.i),
                  }),
                );
              }, `${sub}:${lane.slug.wire}`).then((res) => ({ res, lane }))
            ),
          );
          const { explained } = split5xx(rows);
          for (const { res, lane } of results) {
            const decoded = lane.slug.decoded;
            let expected: number;
            if (lane.op === "put") expected = expectedPutStatus(lane.slug);
            else if (segmentNormalizesAway(lane.slug.wire)) expected = 404;
            else if (lane.op === "delete") {
              expected = decoded === null ? 400 : 204;
            } else {expected = decoded === null
                ? 400
                : catalog.has(decoded)
                ? 200
                : 404;}
            if (res.status !== expected && !explained.includes(res.row)) {
              surprises.push({
                seed: STRESS_SEED,
                round: r,
                id: lane.slug.id,
                wire: lane.slug.wire,
                op: lane.op,
                expected,
                status: res.status,
                body: res.body,
              });
            }
          }
          for (const row of savedRows(h)) {
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(row.slug)) {
              persistedInvalid += 1;
            }
          }
        }
        observations.surprises = surprises;
        observations.rows = savedRows(h).length;
        inv(
          invariants,
          "every fuzzed request matches the route oracle (400 malformed/shape, 404 unknown catalog slug or folded segment, 200/204 otherwise) — modulo the classified PUT/DELETE race",
          surprises.length === 0,
          `${surprises.length} surprises: ${
            JSON.stringify(surprises.slice(0, 5))
          }`,
        );
        inv(
          invariants,
          "only shape-valid slugs ever persist",
          persistedInvalid === 0,
          `${persistedInvalid} invalid rows`,
        );
        fiveXxInvariants(invariants, rows, observations);
      },
    );
    assertReport(report);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// REPRO (defect) — deterministic pins for what the campaign classified
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "REPRO (defect): PUT /v1/me/saved-drills/:slug answers 503 when the caller's own DELETE lands between the upsert and the read-back select",
  async () => {
    const h = await loadXcHarness();
    installSavedDrillsTable(h);
    h.fake.reset(STRESS_SEED, 0);
    const sub = crypto.randomUUID();
    const session = await bootstrap(h, sub, "10.99.0.1");
    const slug = "wall-dink-rally";
    let fired = 0;
    let deleteStatus = 0;
    stressHooks.beforeSelect = async (who, url) => {
      if (
        who.userId !== sub || url.searchParams.get("slug") !== `eq.${slug}` ||
        fired
      ) return;
      fired += 1;
      // The PUT's upsert has committed; before its read-back runs the same user
      // unsaves the drill (a perfectly ordinary tap-tap on the bookmark icon).
      const res = await h.handler(
        edgeRequest("DELETE", `/v1/me/saved-drills/${slug}`, {
          token: session.accessToken,
          ip: "10.99.0.2",
        }),
      );
      deleteStatus = res.status;
    };
    try {
      const put = await h.handler(
        edgeRequest("PUT", `/v1/me/saved-drills/${slug}`, {
          token: session.accessToken,
          ip: "10.99.0.3",
        }),
      );
      const body = await put.json();
      assertEquals(fired, 1, "interleaving hook fired exactly once");
      assertEquals(deleteStatus, 204, "the interleaved DELETE succeeded");
      assertEquals(
        (h.fake.counters["rest.post.user_saved_drills"] ?? 0) >= 1 &&
          (h.fake.counters["rest.delete.user_saved_drills"] ?? 0) === 1,
        true,
        "upsert then delete both reached PostgREST",
      );
      // CONTRACT (index.ts saveDrill): 200 {saved:true}, or at worst a 4xx the
      // client can interpret; 503 is reserved for upstream failure. OBSERVED:
      assertEquals(
        put.status,
        503,
        "REPRO: PUT surfaces the read-back miss as a 503",
      );
      assertEquals(
        body.error.message,
        "Drill save is temporarily unavailable. Please try again.",
      );
      assertEquals(
        savedRows(h).filter((r) => r.user_id === sub).length,
        0,
        "the user's final state is 'unsaved'",
      );
    } finally {
      stressHooks.beforeSelect = undefined;
    }
  },
);

Deno.test(
  "REPRO (defect): drillInstructionalMedia throws TypeError for Object.prototype key slugs (unreachable via the handler, which 404s first)",
  async () => {
    const media = await import("../drillMedia.ts");
    const throwing: string[] = [];
    const returned: Record<string, unknown> = {};
    for (
      const slug of [
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "isPrototypeOf",
        "__proto__",
      ]
    ) {
      try {
        returned[slug] = await media.drillInstructionalMedia(slug);
      } catch (error) {
        throwing.push(
          `${slug}: ${(error as Error).constructor.name}: ${
            (error as Error).message
          }`,
        );
      }
    }
    // CONTRACT: an unknown slug has no media → []. OBSERVED: `MEDIA_BY_SLUG[slug]
    // ?? []` resolves inherited Object.prototype methods (truthy, so `??`
    // keeps them) and `keys.map` is not a function.
    assertEquals(
      throwing.filter((t) =>
        /^(constructor|toString|hasOwnProperty|valueOf|isPrototypeOf): TypeError:/
          .test(t)
      ).length,
      5,
      `REPRO: prototype-key slugs throw inside drillInstructionalMedia: ${
        JSON.stringify(throwing)
      }`,
    );
    for (const [slug, out] of Object.entries(returned)) {
      assertEquals(out, [], `${slug}: no media`);
    }
    // Reachability through the real handler: drillCatalogEntry uses .find on
    // the catalog array, so the route answers 404 before media is consulted.
    const h = await loadXcHarness();
    installSavedDrillsTable(h);
    h.fake.reset(STRESS_SEED, 0);
    const session = await bootstrap(h, crypto.randomUUID(), "10.98.0.1");
    const statuses = await Promise.all(
      [
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "isPrototypeOf",
        "__proto__",
      ].map(async (slug, i) =>
        (await h.handler(
          edgeRequest("GET", `/v1/catalog/drills/${slug}`, {
            token: session.accessToken,
            ip: `10.98.0.${i + 2}`,
          }),
        )).status
      ),
    );
    assertEquals(
      statuses,
      [404, 404, 404, 404, 404, 404],
      "handler 404s prototype-key slugs (defect not reachable via HTTP today)",
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary table (seed → outcome) for the coordinator
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress: write summary.json", async () => {
  const dir = stressOutDir();
  await Deno.mkdir(dir, { recursive: true });
  const summary = {
    unit: "edge-drills-media",
    lens: "concurrency",
    seed: STRESS_SEED,
    scale: { STRESS_ITER, STRESS_BURST, STRESS_LATENCY_MS },
    requests: reports.reduce((n, r) => n + r.requests, 0),
    pureCalls: reports.reduce(
      (n, r) => n + Number(r.observations.pureCalls ?? 0),
      0,
    ),
    knownRace503: reports.reduce(
      (n, r) => n + Number(r.observations.knownRace503 ?? 0),
      0,
    ),
    scenarios: reports.map((r) => ({
      scenario: r.scenario,
      requests: r.requests,
      durationMs: r.durationMs,
      outcome: r.invariants.every((i) => i.holds)
        ? "HELD"
        : r.invariants.every((i) => i.holds || i.known)
        ? `BROKEN(known:${
          [...new Set(r.invariants.filter((i) => i.known).map((i) => i.known))]
            .join(",")
        })`
        : "BROKEN",
      broken: r.invariants.filter((i) => !i.holds).map((i) =>
        `${i.known ? `[known:${i.known}] ` : ""}${i.name} — ${i.detail}`
      ),
      knownRace503: r.observations.knownRace503 ?? 0,
      replay: r.replay,
    })),
  };
  await Deno.writeTextFile(
    `${dir}summary.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(
    `[stress] summary → ${dir}summary.json (${summary.requests} requests, ${summary.pureCalls} pure calls)`,
  );
  assertEquals(reports.length, 8, "every scenario reported");
});
