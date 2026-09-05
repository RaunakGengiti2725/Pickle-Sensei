/**
 * stress: edge-cache × CONCURRENCY — cache.ts L1/L2 under seeded Promise.all
 * bursts across several REAL module isolates sharing one seeded fake Upstash.
 *
 *   C1 logout fence race     revocation marker + cacheDel racing reads on K isolates
 *   C2 fenced build race     cacheFence/cacheSetFenced vs cacheDel vs read-through
 *   C3 key flood             >5 000 keys / >5 000 generations while a revoked
 *                            session is being read; eviction must stay bounded
 *   C4 TTL / clock skew      isolate clock jumps + Redis clock skew mid-burst
 *   C5 Upstash hang / down   bounded wall time, no deadlock, fallback contract,
 *                            cancel-during-call, recovery
 *   C6 shared window counter cross-isolate INCR: no lost update, no double count
 *   H1 real handler          index.ts × K isolates: GET /v1/rank vs a duplicated
 *                            POST /v1/shots:sync — one row / one rating / coherent
 *
 * Each iteration is one seeded interleaving; the seed → outcome table lands in
 * artifacts/stress-edge-cache/latest/<scenario>.json. Outcomes: HELD, BROKEN,
 * DOCUMENTED (a degraded-mode answer the code comments and the [defect] tests
 * in cache.test.ts already pin — reported, not failed). Timing-dependent
 * BROKEN lines whose interleaving a deterministic reproducer in this file
 * forces (C2m, C7m) are tagged BROKEN[C2m]/[C7m]: the seeded scenario then
 * reports their rate and asserts only on UNPINNED breaks; the reproducers are
 * [defect] tests in the cache.test.ts sense (they pin the observed behaviour).
 *
 * Fast by default (STRESS_ITER=4). Campaign: STRESS_ITER=75 (7 × 75 = 525 seeds
 * here + 75 in stress_edge_cache_pg.test.ts against a real postgres:16).
 */
import { assertEquals } from "@std/assert";
import {
  brokenSeeds,
  type CacheIsolate,
  describeMode,
  edgeRequest,
  type HandlerIsolate,
  Ledger,
  loadCacheIsolate,
  loadHandlerIsolate,
  now,
  outDir,
  pickRedisMode,
  Prng,
  restoreGlobals,
  runScenario,
  shiftClock,
  sleep,
  STRESS_ITER,
  timed,
  type TimedResponse,
  unpinnedBrokenSeeds,
  World,
} from "./stress_edge_cache_harness.ts";
import {
  fakeGoogleIdToken,
  syncShotPayload,
} from "./xc_concurrency_harness.ts";

const FILE = "stress_edge_cache_concurrency.test.ts";

let pool: CacheIsolate[] | null = null;
async function isolates(prng: Prng, k: number): Promise<CacheIsolate[]> {
  if (!pool) {
    pool = await Promise.all(
      Array.from({ length: 4 }, () => loadCacheIsolate()),
    );
  }
  return prng.shuffle(pool).slice(0, k);
}

const pick = <T>(prng: Prng, items: T[]): T =>
  items[prng.int(0, items.length - 1)];

/** Promise.all with a deadline: a hung lane is a deadlock finding, not a
 * test that never ends. */
async function bounded<T>(
  lanes: Array<Promise<T>>,
  ms: number,
  ledger: Ledger,
  what: string,
): Promise<number> {
  const t0 = now();
  let timer: number | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const result = await Promise.race([
    Promise.all(lanes).then(() => "done" as const),
    timeout,
  ]);
  clearTimeout(timer);
  const wall = now() - t0;
  if (result === "timeout") {
    ledger.broken(`${what}: lanes still pending after ${ms} ms (deadlock)`);
  }
  ledger.count(`${what}.wallMs`, Math.round(wall));
  return wall;
}

// ─── C1 ──────────────────────────────────────────────────────────────────────

Deno.test("C1 logout fence race: marker+cacheDel vs cacheGetUnlessRevoked bursts across isolates", async () => {
  const table = await runScenario(
    FILE,
    "C1_logout_fence_race",
    "C1 logout fence race",
    STRESS_ITER,
    async (seed, ledger, inputs) => {
      const prng = new Prng(seed);
      const world = new World(seed);
      world.install();
      const mode = pickRedisMode(prng);
      const isos = await isolates(prng, prng.int(2, 4));
      const row = `c1:${seed}:auth:row`;
      const marker = `c1:${seed}:auth:revoked`;
      const writer = pick(prng, isos);
      const revokers = [pick(prng, isos)];
      if (prng.next() < 0.35) revokers.push(pick(prng, isos)); // duplicate logout
      const reads = prng.int(12, 24);
      const spread = prng.int(10, 60);
      Object.assign(inputs, {
        mode: describeMode(mode),
        isolates: isos.map((i) => i.id),
        writer: writer.id,
        revokers: revokers.map((i) => i.id),
        reads,
        spreadMs: spread,
      });

      // setup (healthy): writer verifies the session; some isolates read it through
      assertEquals(await writer.cache.cacheSet(row, "session", 570), true);
      for (const iso of isos) {
        if (iso !== writer && prng.next() < 0.7) {
          const hit = await iso.cache.cacheGetUnlessRevoked(row, marker);
          if (hit.value !== "session") {
            ledger.broken(
              `setup read-through on iso ${iso.id} → ${JSON.stringify(hit)}`,
            );
          }
        }
      }
      world.redis.mode = mode;

      const events: Array<
        {
          iso: number;
          tStart: number;
          tEnd: number;
          value: string | null;
          revoked: boolean;
        }
      > = [];
      const fences: Array<
        {
          iso: number;
          tStart: number;
          tMarker: number;
          landed: boolean;
          tDel: number;
        }
      > = [];
      const lanes: Array<Promise<void>> = [];
      for (let r = 0; r < reads; r += 1) {
        const delay = prng.int(0, spread);
        const iso = pick(prng, isos);
        lanes.push((async () => {
          await sleep(delay);
          const tStart = now();
          const hit = await iso.cache.cacheGetUnlessRevoked(row, marker);
          events.push({
            iso: iso.id,
            tStart,
            tEnd: now(),
            value: hit.value,
            revoked: hit.revoked,
          });
        })());
      }
      for (const revoker of revokers) {
        const delay = prng.int(0, spread);
        lanes.push((async () => {
          await sleep(delay);
          const tStart = now();
          const landed = await revoker.cache.cacheSet(marker, "1", 660);
          const tMarker = now();
          await revoker.cache.cacheDel(row);
          fences.push({
            iso: revoker.id,
            tStart,
            tMarker,
            landed,
            tDel: now(),
          });
        })());
      }
      await bounded(lanes, 5_000, ledger, "burst");
      ledger.count("reads", events.length);

      const firstFence = Math.min(...fences.map((f) => f.tStart));
      const landedFences = fences.filter((f) => f.landed);
      const tLanded = landedFences.length
        ? Math.min(...landedFences.map((f) => f.tMarker))
        : Infinity;
      for (const e of events) {
        if (e.revoked && e.tEnd < firstFence) {
          ledger.broken(
            `iso ${e.iso} reported revoked before any fence began`,
          );
        }
        if (e.value === null) continue;
        const sameIsoDel = fences.find((f) =>
          f.iso === e.iso && f.tDel < e.tStart
        );
        if (sameIsoDel) {
          ledger.broken(
            `same-isolate stale: iso ${e.iso} served the row ${
              (e.tStart - sameIsoDel.tDel).toFixed(2)
            } ms after its own cacheDel`,
          );
          continue;
        }
        if (e.tStart > tLanded) {
          if (world.redis.faultWithin(e.tStart, e.tEnd)) {
            ledger.documented(
              `iso ${e.iso} served the row from L1 during a Redis fault ${
                (e.tStart - tLanded).toFixed(2)
              } ms after the marker landed (L2 unreachable → L1 fallback, cache.ts:184)`,
            );
          } else {
            ledger.broken(
              `iso ${e.iso} served the row ${
                (e.tStart - tLanded).toFixed(2)
              } ms after the marker landed in L2 with Redis healthy`,
            );
          }
        }
      }

      // post: Redis healthy again — the fence must be final everywhere it reached
      world.redis.mode = { kind: "healthy" };
      for (const iso of isos) {
        const hit = await iso.cache.cacheGetUnlessRevoked(row, marker);
        const isRevoker = revokers.some((r) => r.id === iso.id);
        if (landedFences.length > 0) {
          if (!hit.revoked) {
            ledger.broken(
              `post: iso ${iso.id} not revoked although the marker is in L2 (${
                JSON.stringify(hit)
              })`,
            );
          }
        } else if (isRevoker) {
          if (hit.revoked !== true && hit.value !== null) {
            ledger.broken(
              `post: revoker iso ${iso.id} still serves the row after its own fence (${
                JSON.stringify(hit)
              })`,
            );
          }
        } else if (hit.value !== null) {
          ledger.documented(
            `post: marker never reached L2 (Redis ${
              describeMode(mode)
            } during logout); iso ${iso.id} keeps serving its L1 copy until it ages out (index.ts fenceRevokedSession warning; cache.test.ts [defect] cross-isolate cacheDel)`,
          );
        }
      }
      ledger.count("redis.requests", world.redis.requests);
      ledger.count("redis.faults", world.redis.faults);
    },
  );
  assertEquals(table.summary.BROKEN, 0, brokenSeeds(table));
});

// ─── C2 ──────────────────────────────────────────────────────────────────────

Deno.test("C2 fenced build race: cacheFence/cacheSetFenced vs cacheDel vs read-through across isolates", async () => {
  const table = await runScenario(
    FILE,
    "C2_fenced_build_race",
    "C2 fenced build race",
    STRESS_ITER,
    async (seed, ledger, inputs) => {
      const prng = new Prng(seed);
      const world = new World(seed);
      world.install();
      const mode = pickRedisMode(prng);
      const isos = await isolates(prng, prng.int(2, 4));
      const key = `c2:${seed}:rank`;
      const db = { version: 0 };
      const builders = prng.int(4, 10);
      const invalidators = prng.int(2, 5);
      const readers = prng.int(6, 16);
      const pollers = prng.int(1, 2);
      const spread = prng.int(20, 80);
      Object.assign(inputs, {
        mode: describeMode(mode),
        isolates: isos.map((i) => i.id),
        builders,
        invalidators,
        readers,
        pollers,
        spreadMs: spread,
      });

      // setup (healthy): version 0 cached everywhere
      for (const iso of isos) {
        const fence = await iso.cache.cacheFence(key);
        await iso.cache.cacheSetFenced(fence, "0", 60);
      }
      world.redis.mode = mode;

      interface Del {
        iso: number;
        version: number;
        tStart: number;
        tDone: number;
      }
      interface Read {
        iso: number;
        tStart: number;
        tEnd: number;
        value: string | null;
      }
      const dels: Del[] = [];
      const reads: Read[] = [];
      const builds: Array<
        {
          iso: number;
          version: number;
          wrote: boolean;
          tStart: number;
          tEnd: number;
        }
      > = [];
      const lanes: Array<Promise<void>> = [];
      let burstDone = false;
      for (let b = 0; b < builders; b += 1) {
        const delay = prng.int(0, spread);
        const g1 = prng.int(0, 12);
        const g2 = prng.int(0, 12);
        const iso = pick(prng, isos);
        lanes.push((async () => {
          await sleep(delay);
          const tStart = now();
          const fence = await iso.cache.cacheFence(key);
          await sleep(g1);
          const version = db.version; // the "DB read" — coherent with the fence order
          await sleep(g2);
          const localMoved =
            iso.cache.cacheLocalGeneration(key) !== fence.local;
          const wrote = await iso.cache.cacheSetFenced(
            fence,
            String(version),
            60,
          );
          if (localMoved && wrote) {
            ledger.broken(
              `fence failure: iso ${iso.id} fenced write of v${version} ACCEPTED although this isolate's generation moved before the write (cache.ts:317)`,
            );
          }
          builds.push({ iso: iso.id, version, wrote, tStart, tEnd: now() });
        })());
      }
      for (let d = 0; d < invalidators; d += 1) {
        const delay = prng.int(0, spread);
        const iso = pick(prng, isos);
        lanes.push((async () => {
          await sleep(delay);
          db.version += 1; // the "commit"
          const version = db.version;
          const tStart = now();
          await iso.cache.cacheDel(key);
          dels.push({ iso: iso.id, version, tStart, tDone: now() });
        })());
      }
      for (let r = 0; r < readers; r += 1) {
        const delay = prng.int(0, spread + 20);
        const iso = pick(prng, isos);
        lanes.push((async () => {
          await sleep(delay);
          const tStart = now();
          const value = await iso.cache.cacheGet(key);
          reads.push({ iso: iso.id, tStart, tEnd: now(), value });
        })());
      }
      for (let p = 0; p < pollers; p += 1) {
        const iso = pick(prng, isos);
        lanes.push((async () => {
          while (!burstDone) {
            const tStart = now();
            const value = await iso.cache.cacheGet(key);
            reads.push({ iso: iso.id, tStart, tEnd: now(), value });
            await sleep(1);
          }
        })());
      }
      const core = lanes.slice(0, builders + invalidators + readers);
      await bounded(core, 5_000, ledger, "burst");
      burstDone = true;
      await bounded(
        lanes.slice(builders + invalidators + readers),
        2_000,
        ledger,
        "pollers",
      );
      ledger.count("reads", reads.length);
      ledger.count("builds.wrote", builds.filter((b) => b.wrote).length);
      ledger.count("builds.rejected", builds.filter((b) => !b.wrote).length);

      // How did isolate `iso` come to hold v`seen` when the invalidation `inv`
      // (to a newer version) has completed?
      //   legit copy   a read/build of v`seen` on `iso` STARTED before `inv`
      //                completed (or the v0 setup) — the L1 copy predates the
      //                invalidation and ages out ≤ 60 s: the pinned [defect]
      //                "cross-isolate cacheDel leaves the OTHER isolate's L1
      //                copy alive" → DOCUMENTED, unless `iso` ran `inv` itself
      //   own del      `iso` ran `inv`, which cleared its L1 synchronously
      //                right after the generation bump, and cacheSetFenced
      //                fills L1 only BEFORE its await behind that same sync
      //                generation check (asserted directly in the builder
      //                lane above) — so the only L1 writer left is
      //                cacheGet's unfenced fill (cache.ts:117-131): a
      //                read-through overlapping the del → BROKEN[C7m];
      //                otherwise the row came back out of L2 → BROKEN[C2m]
      //   fresh        no pre-invalidation copy: L2 handed out a stale row that
      //                a refused fenced write had re-published → BROKEN[C2m]
      const classifyStale = (
        iso: number,
        seen: number,
        inv: Del,
        what: string,
        exclude?: Read,
      ) => {
        if (inv.iso === iso) {
          const overlappingRead = reads.some((x) =>
            x !== exclude && x.iso === iso && x.value !== null &&
            Number(x.value) === seen && x.tStart < inv.tDone &&
            x.tEnd > inv.tStart
          );
          if (overlappingRead) {
            ledger.broken(
              `same-isolate lost invalidation: ${what} (a read-through in flight across this isolate's own cacheDel re-filled L1; cache.ts:117-131)`,
              "C7m",
            );
          } else {
            ledger.broken(
              `same-isolate lost invalidation: ${what} (row read back out of L2 after this isolate's own cacheDel; cache.ts:319-349)`,
              "C2m",
            );
          }
          return;
        }
        const legit = seen === 0 ||
          reads.some((x) =>
            x !== exclude && x.iso === iso && x.value !== null &&
            Number(x.value) === seen && x.tStart < inv.tDone
          ) ||
          builds.some((b) =>
            b.iso === iso && b.version === seen && b.tStart < inv.tDone
          );
        if (legit) {
          ledger.documented(
            `${what} — pre-invalidation L1 copy ages out within 60 s (cache.test.ts [defect] cross-isolate cacheDel)`,
          );
        } else {ledger.broken(
            `cross-isolate stale via L2: ${what} (no pre-invalidation copy on this isolate; a refused fenced write re-published the row for one RTT; cache.ts:319-349)`,
            "C2m",
          );}
      };

      // during: a read that started after an invalidation completed must not
      // see a version older than that invalidation
      for (const r of reads) {
        if (r.value === null) continue;
        const seen = Number(r.value);
        const stale = dels.filter((d) =>
          d.tDone < r.tStart && d.version > seen
        );
        if (stale.length === 0) continue;
        const inv = stale.reduce((a, b) => (a.version < b.version ? a : b)); // the one that retired v`seen`
        const lag = (r.tStart - inv.tDone).toFixed(2);
        if (world.redis.faultWithin(inv.tStart, r.tEnd)) {
          // cacheDel's INCR/DEL or the fenced SET's verification pipeline was
          // dropped: the row survives in L2 / L1-only until its TTL, exactly
          // as the cache.ts:306-334 contract says an unreachable Redis degrades
          ledger.documented(
            `iso ${r.iso} read v${seen} ${lag} ms after ${
              inv.iso === r.iso ? "its own" : `iso ${inv.iso}'s`
            } cacheDel at v${inv.version} during a Redis fault (L1-only row / DEL not delivered; cache.ts:306-334)`,
          );
          continue;
        }
        classifyStale(
          r.iso,
          seen,
          inv,
          `iso ${r.iso} read v${seen} ${lag} ms after ${
            inv.iso === r.iso ? "its own" : `iso ${inv.iso}'s`
          } cacheDel completed at v${inv.version}`,
          r,
        );
      }

      // post: every isolate and L2 must hold the final version or nothing
      world.redis.mode = { kind: "healthy" };
      const l2 = world.redis.get(key);
      if (l2 !== null && Number(l2) !== db.version) {
        if (mode.kind === "healthy") {
          ledger.broken(
            `post: L2 holds v${l2}, DB is v${db.version}`,
          );
        } else {ledger.documented(
            `post: L2 holds v${l2}, DB is v${db.version} (cacheDel's DEL lost to a Redis fault; 60 s TTL bounds it, index.ts getPlayerRank comment)`,
          );}
      }
      for (const iso of isos) {
        const value = await iso.cache.cacheGet(key);
        if (value === null || Number(value) === db.version) continue;
        const seen = Number(value);
        const inv = dels.find((d) => d.version === seen + 1);
        if (mode.kind !== "healthy") {
          ledger.documented(
            `post: iso ${iso.id} serves v${value}, DB is v${db.version} — Redis ${
              describeMode(mode)
            } left an L1-only row (cache.ts:330-334)`,
          );
        } else if (!inv) {
          ledger.broken(
            `post: iso ${iso.id} serves v${value} after settle, DB is v${db.version} (no recorded invalidation of v${seen})`,
          );
        } else {
          classifyStale(
            iso.id,
            seen,
            inv,
            `post: iso ${iso.id} serves v${value} after settle, DB is v${db.version}`,
          );
        }
      }
      ledger.count("redis.requests", world.redis.requests);
      ledger.count("redis.faults", world.redis.faults);
    },
  );
  assertEquals(table.summary.brokenUnpinned, 0, unpinnedBrokenSeeds(table));
});

// ─── C2m: minimal deterministic interleaving of the C2 failure ───────────────
//
//   A: fence = cacheFence(k)                      (shared generation g)
//   B: cacheDel(k)                                (L2: gen g+1, row gone; B.L1 empty)
//   A: cacheSetFenced(fence, stale)  → pipeline [GET gen, SET k stale] lands
//   B: cacheGet(k)   ← exactly here  → L2 GET returns `stale`, B.L1 caches it 60 s
//   A: sees gen mismatch, DEL k                   (L2 clean again — but B.L1 is not)
//
// cache.ts:319-337 says "no stale row survives"; the SET is unconditional and
// the DEL is a second round trip, so the row is readable in L2 for one RTT
// and any isolate that reads through in that window keeps it for a full
// L1 read-through TTL. Expected: B never serves `stale` after its own
// invalidation completed. No seed needed — the interleaving is forced.
//
// Written like the [defect] tests in cache.test.ts: it PINS the observed
// behaviour so the suite stays green and flips the day cache.ts is fixed
// (then invert the last assertion to `null`).

Deno.test("[defect] C2m minimal: stale fenced SET re-published to L2 for one RTT is cached by another isolate's read-through", async () => {
  const world = new World(1, { latencyMaxMs: 0 });
  world.install();
  const [a, b] = await isolates(new Prng(1), 2);
  const key = "c2m:rank";
  const db = { version: 0 };
  const fenceA = await a.cache.cacheFence(key);
  const versionReadByA = db.version;
  db.version += 1; // the "commit" that busts the key
  await b.cache.cacheDel(key);
  const l2AfterDel = world.redis.get(key);
  const seenByB: Array<{ when: string; value: string | null }> = [];
  let readDuringWindow: Promise<void> | null = null;
  world.redis.onApplied = (commands) => {
    if (
      commands.some((c) => c.startsWith(`SET ${key} `)) && !readDuringWindow
    ) {
      readDuringWindow = b.cache.cacheGet(key).then((value) => {
        seenByB.push({ when: "after A's SET landed, before A's DEL", value });
      });
    }
  };
  const wrote = await a.cache.cacheSetFenced(
    fenceA,
    String(versionReadByA),
    60,
  );
  await readDuringWindow;
  world.redis.onApplied = null;
  const l2Final = world.redis.get(key);
  const bServesLater = await b.cache.cacheGet(key);
  seenByB.push({ when: "after A's DEL completed", value: bServesLater });
  const table = {
    scenario: "C2m_minimal_stale_republish",
    versionReadByA,
    dbVersion: db.version,
    l2AfterDel,
    fencedWriteAccepted: wrote,
    l2Final,
    seenByB,
    redisCommands: world.redis.log.map((r) => r.commands.join("; ")),
  };
  await Deno.mkdir(outDir(), { recursive: true });
  await Deno.writeTextFile(
    `${outDir()}C2m_minimal_stale_republish.json`,
    JSON.stringify(table, null, 2),
  );
  assertEquals(l2AfterDel, null, "B's cacheDel must clear L2");
  assertEquals(
    wrote,
    false,
    "A's fenced write must be refused (generation moved)",
  );
  assertEquals(l2Final, null, "L2 must be clean once A's DEL lands");
  assertEquals(
    seenByB[0]?.value,
    String(versionReadByA),
    "B's read-through inside the SET→DEL window returns the stale row",
  );
  assertEquals(
    bServesLater,
    String(versionReadByA),
    `[defect] isolate B keeps serving the stale row after its own invalidation (expected null once fixed): ${
      JSON.stringify(table)
    }`,
  );
});

// ─── C7m: minimal deterministic interleaving of the H1 failure ───────────────
//
//   A: cacheGet(k)     L1 miss → pipeline [GET k, TTL k] in flight
//   A: cacheDel(k)     bumps the local generation, clears L1, sends DEL
//   A: GET reply (pre-DEL row) lands → memorySet(k, stale, 60)   ← unfenced
//   A: cacheGet(k)     L1 hit → `stale` for up to 60 s; L2 is already empty
//
// cache.ts:117-131 fills L1 from an L2 reply without comparing the local
// generation captured before the round trip, so a deletion issued by the SAME
// isolate while the read-through is in flight is lost. cacheGetUnlessRevoked
// re-checks L2 on every L1 hit and is not affected; cacheGet (rank/progress,
// index.ts getPlayerRank) is. No seed needed — the interleaving is forced.
// [defect]-style: pins the observed behaviour; invert the last assertion to
// `null` once cacheGet fences its L1 fill.

Deno.test("[defect] C7m minimal: same-isolate cacheDel during an in-flight cacheGet read-through is lost for the L1 TTL", async () => {
  const world = new World(1, { latencyMaxMs: 0 });
  world.install();
  const [a, b] = await isolates(new Prng(1), 2);
  const key = "c7m:rank";
  assertEquals(await b.cache.cacheSet(key, "v0", 60), true); // another isolate published the row
  assertEquals(world.redis.get(key), "v0");
  const inFlight = a.cache.cacheGet(key); // pipeline issued, reply not yet applied to L1
  const del = a.cache.cacheDel(key); // same isolate: L1 cleared + generation bumped now
  const [readThrough] = await Promise.all([inFlight, del]);
  const l2AfterDel = world.redis.get(key);
  const servedAfterDel = await a.cache.cacheGet(key);
  const table = {
    scenario: "C7m_minimal_lost_same_isolate_invalidation",
    readThrough,
    l2AfterDel,
    servedAfterDel,
    redisCommands: world.redis.log.map((r) => r.commands.join("; ")),
  };
  await Deno.mkdir(outDir(), { recursive: true });
  await Deno.writeTextFile(
    `${outDir()}C7m_minimal_lost_same_isolate_invalidation.json`,
    JSON.stringify(table, null, 2),
  );
  assertEquals(
    readThrough,
    "v0",
    "the in-flight read legitimately sees the pre-deletion row",
  );
  assertEquals(l2AfterDel, null, "cacheDel must clear L2");
  assertEquals(
    servedAfterDel,
    "v0",
    `[defect] the isolate that ran cacheDel serves the deleted row from L1 (expected null once fixed): ${
      JSON.stringify(table)
    }`,
  );
});

// ─── C3 ──────────────────────────────────────────────────────────────────────

Deno.test("C3 key flood: >5 000 keys and >5 000 generations while a revoked session is read", async () => {
  const table = await runScenario(
    FILE,
    "C3_key_flood",
    "C3 key flood",
    STRESS_ITER,
    async (seed, ledger, inputs) => {
      const prng = new Prng(seed);
      const world = new World(seed, { latencyMaxMs: 0 });
      world.install();
      const mode: "healthy" | "down" = prng.next() < 0.5 ? "healthy" : "down";
      const [a, b] = await isolates(prng, 2);
      const row = `c3:${seed}:auth:row`;
      const marker = `c3:${seed}:auth:revoked`;
      const rankKey = `c3:${seed}:rank`;
      const floodLanes = prng.int(3, 6);
      // even lanes flood isolate a, odd lanes isolate b: a alone receives
      // > MEMORY_MAX_ENTRIES (5 000) inserts; b bumps > GENERATION_MAX_ENTRIES
      const perLane = Math.ceil(
        prng.int(5_400, 7_000) / Math.ceil(floodLanes / 2),
      );
      const genFlood = prng.int(5_100, 6_500);
      Object.assign(inputs, {
        mode,
        isolates: [a.id, b.id],
        floodLanes,
        perLane,
        genFlood,
      });

      // setup (healthy): a verified session read through on both isolates
      await a.cache.cacheSet(row, "session", 570);
      const warm = await b.cache.cacheGetUnlessRevoked(row, marker);
      if (warm.value !== "session") {
        ledger.broken(
          `setup read-through → ${JSON.stringify(warm)}`,
        );
      }
      world.redis.mode = { kind: mode };
      // logout on `a` under the chosen Redis mode
      const landed = await a.cache.cacheSet(marker, "1", 660);
      await a.cache.cacheDel(row);
      const tFence = now();
      if (mode === "healthy" && !landed) {
        ledger.broken(
          "marker SET did not land with Redis healthy",
        );
      }

      const fence = await b.cache.cacheFence(rankKey);
      let floodDone = false;
      const observations: Array<
        {
          iso: number;
          tStart: number;
          value: string | null;
          revoked: boolean;
          isRevoked: boolean | null;
        }
      > = [];
      const lanes: Array<Promise<void>> = [];
      for (let f = 0; f < floodLanes; f += 1) {
        const iso = f % 2 === 0 ? a : b;
        lanes.push((async () => {
          for (let i = 0; i < perLane; i += 1) {
            await iso.cache.cacheSet(`c3:${seed}:flood:${f}:${i}`, "x", 60);
          }
        })());
      }
      lanes.push((async () => {
        for (let i = 0; i < genFlood; i += 1) {
          await b.cache.cacheDel(`c3:${seed}:gen:${i}`);
        }
      })());
      const pollers = [a, b].map((iso) =>
        (async () => {
          while (!floodDone) {
            const tStart = now();
            const hit = await iso.cache.cacheGetUnlessRevoked(row, marker);
            const isRevoked = await iso.cache.cacheIsRevoked(marker);
            observations.push({
              iso: iso.id,
              tStart,
              value: hit.value,
              revoked: hit.revoked,
              isRevoked,
            });
            await sleep(1);
          }
        })()
      );
      await bounded(lanes, 30_000, ledger, "flood");
      floodDone = true;
      await bounded(pollers, 2_000, ledger, "pollers");
      ledger.count("floodWrites", floodLanes * perLane);
      ledger.count("generationBumps", genFlood);
      ledger.count("observations", observations.length);

      for (const o of observations) {
        if (o.tStart < tFence || o.value === null) continue;
        if (o.iso === a.id) {
          ledger.broken(
            `revoker isolate ${a.id} served the revoked row during the flood`,
          );
        } else if (mode === "healthy") {
          ledger.broken(
            `iso ${o.iso} served the revoked row during the flood with Redis healthy`,
          );
        } else {
          ledger.documented(
            `iso ${o.iso} served its L1 copy of the revoked row while Redis was down (marker never reached L2)`,
          );
        }
      }

      // L1 is bounded: the very first flood key must have been evicted (checked
      // with Redis down so the answer can only come from L1)
      const savedMode = world.redis.mode;
      world.redis.mode = { kind: "down" };
      const firstKeyLocal = await a.cache.cacheGet(`c3:${seed}:flood:0:0`);
      if (firstKeyLocal !== null) {
        ledger.broken(
          "L1 unbounded: the oldest flood key survived >5 000 inserts",
        );
      }
      const markerLocal = await a.cache.cacheIsRevoked(marker);
      const rowLocal = await a.cache.cacheGet(row);
      ledger.count("markerSurvivedL1", markerLocal === true ? 1 : 0);
      if (rowLocal !== null) {
        ledger.broken(
          `revoker isolate ${a.id} still holds the revoked row in L1 after the flood`,
        );
      }
      world.redis.mode = savedMode;

      // generation flood: the fence taken before >2 048 bumps must be refused
      const wrote = await b.cache.cacheSetFenced(fence, "stale", 60);
      if (wrote) {
        ledger.broken(
          "cacheSetFenced accepted a fence that predates the generation-map epoch reset",
        );
      }
      const rank = await b.cache.cacheGet(rankKey);
      if (rank !== null) {
        ledger.broken(
          `stale fenced write became readable: ${rank}`,
        );
      }

      // post (healthy)
      world.redis.mode = { kind: "healthy" };
      const post = await b.cache.cacheGetUnlessRevoked(row, marker);
      if (post.value !== null) {
        if (mode === "healthy") {
          ledger.broken(
            `post: iso ${b.id} still serves the revoked row`,
          );
        } else {ledger.documented(
            `post: logout ran while Redis was down — the row (L2) outlived the marker (never in L2); iso ${b.id} re-read it after recovery (index.ts fenceRevokedSession warning)`,
          );}
      }
      ledger.count("redis.requests", world.redis.requests);
    },
  );
  assertEquals(table.summary.BROKEN, 0, brokenSeeds(table));
});

// ─── C4 ──────────────────────────────────────────────────────────────────────

Deno.test("C4 TTL / clock skew: isolate clock jumps and Redis clock skew during a read burst", async () => {
  const table = await runScenario(
    FILE,
    "C4_ttl_clock_skew",
    "C4 TTL clock skew",
    STRESS_ITER,
    async (seed, ledger, inputs) => {
      const prng = new Prng(seed);
      const world = new World(seed);
      world.install();
      const isos = await isolates(prng, prng.int(2, 3));
      const row = `c4:${seed}:auth:row`;
      const marker = `c4:${seed}:auth:revoked`;
      const ttl = prng.int(30, 570);
      const redisSkewS = prng.int(-120, 120);
      const jumps = [0, 45, 61, ttl + 5, 600].filter(() => prng.next() < 0.6);
      const reads = prng.int(10, 20);
      const spread = prng.int(20, 60);
      const writer = pick(prng, isos);
      const revoker = pick(prng, isos);
      Object.assign(inputs, {
        isolates: isos.map((i) => i.id),
        ttlS: ttl,
        redisSkewS,
        jumpsS: jumps,
        reads,
        spreadMs: spread,
        writer: writer.id,
        revoker: revoker.id,
      });

      world.redis.clockOffsetMs = redisSkewS * 1000;
      await writer.cache.cacheSet(row, "session", ttl);
      for (const iso of isos) {
        if (iso !== writer) {
          await iso.cache.cacheGetUnlessRevoked(row, marker);
        }
      }

      const events: Array<
        {
          iso: number;
          tStart: number;
          value: string | null;
          revoked: boolean;
          clockS: number;
        }
      > = [];
      let clockS = 0;
      let tMarker = Infinity;
      const lanes: Array<Promise<void>> = [];
      for (let r = 0; r < reads; r += 1) {
        const delay = prng.int(0, spread);
        const iso = pick(prng, isos);
        lanes.push((async () => {
          await sleep(delay);
          const tStart = now();
          const hit = await iso.cache.cacheGetUnlessRevoked(row, marker);
          events.push({
            iso: iso.id,
            tStart,
            value: hit.value,
            revoked: hit.revoked,
            clockS,
          });
        })());
      }
      for (const jump of jumps) {
        const delay = prng.int(0, spread);
        lanes.push((async () => {
          await sleep(delay);
          shiftClock(jump * 1000);
          clockS += jump;
        })());
      }
      const revokeAt = prng.int(0, spread);
      lanes.push((async () => {
        await sleep(revokeAt);
        const landed = await revoker.cache.cacheSet(marker, "1", 660);
        if (!landed) ledger.broken("marker SET failed with Redis healthy");
        tMarker = now();
        await revoker.cache.cacheDel(row);
      })());
      await bounded(lanes, 5_000, ledger, "burst");
      ledger.count("reads", events.length);
      for (const e of events) {
        if (e.tStart > tMarker && e.value !== null) {
          ledger.broken(
            `iso ${e.iso} served the row after the marker landed (isolate clock +${e.clockS}s, redis skew ${redisSkewS}s)`,
          );
        }
      }

      // post: far past the row's own lifetime but inside the marker's — the
      // marker (660 s) must still win regardless of the two clocks
      shiftClock(600 * 1000);
      for (const iso of isos) {
        const hit = await iso.cache.cacheGetUnlessRevoked(row, marker);
        if (hit.value !== null) {
          ledger.broken(
            `post: iso ${iso.id} served the row 600 s later`,
          );
        }
      }
      // read-through copies never outlive 60 s of isolate clock: with Redis
      // unreachable, a non-writer isolate must have nothing left
      world.redis.mode = { kind: "down" };
      for (const iso of isos) {
        if (iso === writer) continue;
        const hit = await iso.cache.cacheGetUnlessRevoked(row, marker);
        if (hit.value !== null) {
          ledger.broken(
            `read-through copy on iso ${iso.id} outlived L1_READTHROUGH_TTL_SECONDS`,
          );
        }
      }
      ledger.count("redis.requests", world.redis.requests);
    },
  );
  assertEquals(table.summary.BROKEN, 0, brokenSeeds(table));
});

// ─── C5 ──────────────────────────────────────────────────────────────────────

Deno.test("C5 Upstash hang / down: bounded wall time, fallback contract, cancel-during-call, recovery", async () => {
  const table = await runScenario(
    FILE,
    "C5_upstash_hang",
    "C5 Upstash hang",
    STRESS_ITER,
    async (seed, ledger, inputs) => {
      const prng = new Prng(seed);
      const world = new World(seed);
      world.install();
      const isos = await isolates(prng, prng.int(2, 3));
      const key = `c5:${seed}:k`;
      const marker = `c5:${seed}:auth:revoked`;
      const ops = prng.int(8, 16);
      const abandoned = prng.int(1, 4);
      const kind: "hang" | "down" = prng.next() < 0.7 ? "hang" : "down";
      Object.assign(inputs, {
        isolates: isos.map((i) => i.id),
        ops,
        abandoned,
        mode: kind,
      });

      const writer = pick(prng, isos);
      await writer.cache.cacheSet(key, "warm", 60);
      world.redis.mode = { kind };

      let unhandled = 0;
      const onUnhandled = (event: Event) => {
        unhandled += 1;
        event.preventDefault();
      };
      globalThis.addEventListener("unhandledrejection", onUnhandled);
      const results: Array<
        { op: string; iso: number; ok: boolean; ms: number; detail: string }
      > = [];
      const opKinds = [
        "get",
        "getUnlessRevoked",
        "set",
        "del",
        "fence+setFenced",
        "isRevoked",
        "windowIncr",
        "enforceRateLimit",
      ] as const;
      const run = async (iso: CacheIsolate, op: (typeof opKinds)[number]) => {
        const t0 = now();
        let ok = true;
        let detail = "";
        try {
          switch (op) {
            case "get": {
              const v = await iso.cache.cacheGet(key);
              ok = v === null || v === "warm";
              detail = String(v);
              break;
            }
            case "getUnlessRevoked": {
              const hit = await iso.cache.cacheGetUnlessRevoked(key, marker);
              ok = hit.revoked === false &&
                (hit.value === null || hit.value === "warm");
              detail = JSON.stringify(hit);
              break;
            }
            case "set": {
              const landed = await iso.cache.cacheSet(
                `${key}:set:${iso.id}`,
                "v",
                60,
              );
              ok = landed === false;
              detail = `landed=${landed}`;
              break;
            }
            case "del":
              await iso.cache.cacheDel(`${key}:del`);
              break;
            case "fence+setFenced": {
              const fence = await iso.cache.cacheFence(`${key}:fenced`);
              const wrote = await iso.cache.cacheSetFenced(fence, "v", 60);
              ok = fence.shared === null && wrote === true;
              detail = `shared=${fence.shared} wrote=${wrote}`;
              break;
            }
            case "isRevoked": {
              const r = await iso.cache.cacheIsRevoked(marker);
              ok = r === null;
              detail = String(r);
              break;
            }
            case "windowIncr": {
              const n = await iso.cache.redisWindowIncr(`${key}:win`, 60);
              ok = n === null;
              detail = String(n);
              break;
            }
            case "enforceRateLimit": {
              const rl = await iso.rateLimit.enforceRateLimit(
                "stress5",
                `c5:${seed}`,
                1_000,
                60,
              );
              ok = rl.allowed === true;
              detail = JSON.stringify(rl);
              break;
            }
          }
        } catch (error) {
          ok = false;
          detail = `threw ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        results.push({
          op,
          iso: iso.id,
          ok,
          ms: Math.round(now() - t0),
          detail,
        });
      };
      const lanes: Array<Promise<void>> = [];
      for (let i = 0; i < ops; i += 1) {
        lanes.push(
          run(pick(prng, isos), pick(prng, [...opKinds])),
        );
      }
      // cancel-during-call: fire, do not await, fire again on the same key
      const dangling: Array<Promise<void>> = [];
      for (let i = 0; i < abandoned; i += 1) {
        const iso = pick(prng, isos);
        dangling.push(run(iso, "get"));
        lanes.push(run(iso, "set"));
      }
      const t0 = now();
      const wall = await bounded(lanes, 1_200 + 1_500, ledger, "burst");
      if (kind === "hang" && wall < 1_000) {
        ledger.broken(
          `hang mode returned in ${
            wall.toFixed(0)
          } ms — the 1.2 s timeout never engaged`,
        );
      }
      if (kind === "down" && wall > 500) {
        ledger.broken(
          `down mode took ${wall.toFixed(0)} ms — a 503 must fail fast`,
        );
      }
      for (const r of results) {
        if (!r.ok) {
          ledger.broken(
            `${r.op} on iso ${r.iso}: ${r.detail} (${r.ms} ms)`,
          );
        }
      }
      // per-call latency: concurrent hung calls must overlap, never serialise
      const slowest = Math.max(...results.map((r) => r.ms));
      if (kind === "hang" && slowest > 1_200 + 400) {
        ledger.broken(
          `a single call took ${slowest} ms (> timeout + 400)`,
        );
      }
      ledger.count("ops", results.length);
      ledger.count("wallMs", Math.round(now() - t0));

      // recovery: the moment Redis answers again, the next call lands (no
      // circuit breaker to reset — the [defect] test pins that there is none)
      world.redis.mode = { kind: "healthy" };
      const tR = now();
      const landed = await writer.cache.cacheSet(`${key}:recovered`, "v", 60);
      const recoverMs = now() - tR;
      if (!landed || recoverMs > 200) {
        ledger.broken(
          `recovery: landed=${landed} in ${recoverMs.toFixed(0)} ms`,
        );
      }
      await bounded(dangling, 3_000, ledger, "dangling");
      await sleep(5);
      globalThis.removeEventListener("unhandledrejection", onUnhandled);
      if (unhandled > 0) {
        ledger.broken(
          `${unhandled} unhandled rejection(s) escaped cache.ts`,
        );
      }
      ledger.count("redis.requests", world.redis.requests);
    },
  );
  assertEquals(table.summary.BROKEN, 0, brokenSeeds(table));
});

// ─── C6 ──────────────────────────────────────────────────────────────────────

Deno.test("C6 shared window counter: cross-isolate INCR bursts — no lost update, no double count, fail-open only under faults", async () => {
  const table = await runScenario(
    FILE,
    "C6_window_counter",
    "C6 window counter",
    STRESS_ITER,
    async (seed, ledger, inputs) => {
      const prng = new Prng(seed);
      const world = new World(seed);
      world.install();
      const isos = await isolates(prng, prng.int(2, 4));
      const roll = prng.next();
      const mode = roll < 0.55
        ? { kind: "healthy" as const }
        : roll < 0.8
        ? { kind: "flap" as const, p: 0.1 + prng.next() * 0.3 }
        : roll < 0.9
        ? { kind: "cmd-error" as const }
        : { kind: "truncate" as const };
      const incrs = prng.int(20, 60);
      const rlCalls = prng.int(10, 40);
      const limit = prng.int(5, 20);
      const winKey = `c6:${seed}:win`;
      Object.assign(inputs, {
        mode: describeMode(mode),
        isolates: isos.map((i) => i.id),
        incrs,
        rlCalls,
        limit,
      });
      world.redis.mode = mode;

      const counts: Array<number | null> = [];
      const allowed: boolean[] = [];
      const lanes: Array<Promise<void>> = [];
      for (let i = 0; i < incrs; i += 1) {
        const iso = pick(prng, isos);
        lanes.push((async () => {
          await sleep(prng.int(0, 10));
          counts.push(await iso.cache.redisWindowIncr(winKey, 60));
        })());
      }
      for (let i = 0; i < rlCalls; i += 1) {
        const iso = pick(prng, isos);
        lanes.push((async () => {
          await sleep(prng.int(0, 10));
          const rl = await iso.rateLimit.enforceRateLimit(
            "stress6",
            `c6:${seed}`,
            limit,
            60,
          );
          allowed.push(rl.allowed);
        })());
      }
      await bounded(lanes, 5_000, ledger, "burst");

      const nonNull = counts.filter((c): c is number => c !== null);
      const distinct = new Set(nonNull);
      if (distinct.size !== nonNull.length) {
        ledger.broken(
          `double count: ${
            nonNull.length - distinct.size
          } INCR results duplicated (${
            [...nonNull].sort((a, b) => a - b).join(",")
          })`,
        );
      }
      const final = Number(world.redis.get(winKey));
      if (mode.kind === "healthy") {
        if (nonNull.length !== incrs) {
          ledger.broken(
            `${
              incrs - nonNull.length
            } INCR(s) returned null with Redis healthy`,
          );
        }
        if (final !== incrs) {
          ledger.broken(
            `lost update: L2 counter ${final} after ${incrs} INCRs`,
          );
        }
        for (let n = 1; n <= incrs; n += 1) {
          if (!distinct.has(n)) {
            ledger.broken(`count ${n} never handed out`);
          }
        }
        const ttl = world.redis.ttlSeconds(winKey);
        if (!(ttl > 0 && ttl <= 60)) {
          ledger.broken(
            `window TTL not set once (TTL ${ttl})`,
          );
        }
        const grants = allowed.filter(Boolean).length;
        if (grants !== Math.min(limit, rlCalls)) {
          ledger.broken(
            `rate limit granted ${grants} of ${rlCalls} with limit ${limit} (cross-isolate)`,
          );
        }
      } else {
        // every answered INCR is still exact (Redis is atomic); unanswered ones
        // fail open into per-isolate memory — the documented undercount
        const grants = allowed.filter(Boolean).length;
        if (nonNull.length > 0 && final < Math.max(...nonNull)) {
          ledger.broken(
            `L2 counter ${final} below a handed-out count ${
              Math.max(...nonNull)
            }`,
          );
        }
        if (grants > Math.min(limit, rlCalls)) {
          ledger.documented(
            `fail-open: ${grants} granted with limit ${limit} while Redis was ${
              describeMode(mode)
            } (rateLimit.ts memory fallback; cache.test.ts [defect] separate isolates undercount)`,
          );
        }
        ledger.count("incr.null", counts.length - nonNull.length);
      }
      ledger.count("ops", incrs + rlCalls);
      ledger.count("redis.requests", world.redis.requests);
      ledger.count("redis.faults", world.redis.faults);
    },
  );
  assertEquals(table.summary.BROKEN, 0, brokenSeeds(table));
});

// ─── H1: the REAL handler on several isolates ────────────────────────────────
//
// index.ts re-materialised K times (private cache.ts/rateLimit.ts each, shared
// fake Upstash + shared fake Supabase). One user: GET /v1/rank builds on some
// isolates while POST /v1/shots:sync (the write that busts the rank key) lands
// on another — plus the same shot delivered twice from two isolates at once.
//
//   no double spend    the duplicated sync yields exactly one shot row, one
//                      scored rating and one finalized permit
//   idempotency        both deliveries report the shot as accepted
//   cache coherence    every GET /v1/rank that STARTS after the accepting sync
//                      RETURNED must show the post-sync rating (Redis healthy)

let handlerPool: HandlerIsolate[] | null = null;
async function handlerIsolates(
  prng: Prng,
  k: number,
): Promise<HandlerIsolate[]> {
  if (!handlerPool) {
    handlerPool = [];
    for (let i = 0; i < 3; i += 1) handlerPool.push(await loadHandlerIsolate());
  }
  return prng.shuffle(handlerPool).slice(0, k);
}

Deno.test("H1 real handler: GET /v1/rank on K isolates vs POST /v1/shots:sync (duplicated) — one row, one rating, coherent rank", async () => {
  const table = await runScenario(
    FILE,
    "H1_real_handler_rank_vs_sync",
    "H1 real handler",
    STRESS_ITER,
    async (seed, ledger, inputs) => {
      const prng = new Prng(seed);
      const world = new World(seed, { supabase: true });
      world.install();
      const fake = world.fake!;
      const isos = await handlerIsolates(prng, prng.int(2, 3));
      const sub = prng.uuid();
      const ip = `203.0.113.${1 + (seed % 200)}`;
      const readers = prng.int(6, 14);
      const spread = prng.int(8, 40);
      Object.assign(inputs, {
        isolates: isos.map((i) => i.id),
        readers,
        spreadMs: spread,
      });

      // the DB view the rank route reads; the accepting sync moves the score
      const db = { version: 0 };
      const technique = () => ({
        user_id: sub,
        shot_type: "dink",
        score: 7 + db.version,
        captured_at: "2026-09-01T10:00:00.000Z",
        sampled_count: 1 + db.version,
        confidence_weight: 1,
      });
      fake.tables.player_technique_rating = [];
      fake.tables.player_rank_state = [];
      const applyOriginal = fake.applySyncedShot.bind(fake);
      const rated = new Set<string>();
      fake.applySyncedShot = async (userId, shot) => {
        const result = await applyOriginal(userId, shot);
        const id = String(shot.id);
        const inserted = fake.tables.shots.some((s) =>
          s.id === id && s.result_kind === "scored"
        );
        if (result === "accepted" && inserted && !rated.has(id)) {
          rated.add(id);
          db.version += 1; // committed inside the RPC, like the rating trigger
          fake.tables.player_technique_rating = [technique()];
        }
        return result;
      };

      // bootstrap on one isolate, reserve a permit on another
      const boot = await timed(
        pick(prng, isos).handler,
        edgeRequest("POST", "/v1/account/bootstrap", {
          token: fakeGoogleIdToken(sub),
          ip,
          body: {},
        }),
      );
      const token = String(
        (boot.body.session as Record<string, unknown> | undefined)
          ?.accessToken ?? "",
      );
      if (boot.status !== 200 || !token) {
        ledger.broken(
          `bootstrap → ${boot.status} ${JSON.stringify(boot.body)}`,
        );
        return;
      }
      fake.tables.player_technique_rating = [technique()];
      const reserved = await timed(
        pick(prng, isos).handler,
        edgeRequest("POST", "/v1/analysis-permits", {
          token,
          ip,
          body: { idempotencyKey: `h1-${seed}` },
        }),
      );
      const permitId = String(
        (reserved.body.permit as Record<string, unknown> | undefined)?.id ?? "",
      );
      if (reserved.status !== 200 || !permitId) {
        ledger.broken(
          `permit → ${reserved.status} ${JSON.stringify(reserved.body)}`,
        );
        return;
      }
      // warm the rank on SOME isolates (their L1 keeps a pre-sync copy — the
      // pinned [defect] cross-isolate cacheDel limit); the others start cold and
      // can only learn the rank through L2 or their own build
      const warmed = new Set<number>();
      for (const iso of isos) {
        if (prng.next() < 0.5) continue;
        const warm = await timed(
          iso.handler,
          edgeRequest("GET", "/v1/rank", { token, ip }),
        );
        const rating = (warm.body.rank as Record<string, unknown> | null)
          ?.rating;
        if (warm.status !== 200 || rating !== 7) {
          ledger.broken(
            `warm rank on iso ${iso.id} → ${warm.status} ${
              JSON.stringify(warm.body)
            }`,
          );
        }
        warmed.add(iso.id);
      }
      inputs.warmed = [...warmed];

      const shotId = prng.uuid();
      const syncIsos = [pick(prng, isos), pick(prng, isos)];
      const syncDelay = prng.int(0, spread);
      const syncs: TimedResponse[] = [];
      const rankReads: Array<
        {
          iso: number;
          tStart: number;
          tEnd: number;
          status: number;
          rating: unknown;
        }
      > = [];
      const lanes: Array<Promise<void>> = [];
      for (const iso of syncIsos) {
        lanes.push((async () => {
          await sleep(syncDelay);
          syncs.push(
            await timed(
              iso.handler,
              edgeRequest("POST", "/v1/shots:sync", {
                token,
                ip,
                body: { shots: [syncShotPayload(shotId, permitId)] },
              }),
            ),
          );
        })());
      }
      for (let r = 0; r < readers; r += 1) {
        const iso = pick(prng, isos);
        const delay = prng.int(0, spread + 20);
        lanes.push((async () => {
          await sleep(delay);
          const res = await timed(
            iso.handler,
            edgeRequest("GET", "/v1/rank", { token, ip }),
          );
          rankReads.push({
            iso: iso.id,
            tStart: res.tStart,
            tEnd: res.tEnd,
            status: res.status,
            rating: (res.body.rank as Record<string, unknown> | null)?.rating ??
              null,
          });
        })());
      }
      await bounded(lanes, 8_000, ledger, "burst");
      ledger.count("rankReads", rankReads.length);

      // no double spend / idempotency
      const acceptedBy = syncs.filter((s) =>
        ((s.body.acceptedIds ?? []) as string[]).includes(shotId)
      );
      const shotRows = fake.tables.shots.filter((s) => s.id === shotId);
      const scored =
        fake.tables.shots.filter((s) =>
          s.user_id === sub && s.result_kind === "scored"
        ).length;
      const permit = fake.tables.analysis_permits.find((p) =>
        p.id === permitId
      );
      if (acceptedBy.length !== 2) {
        ledger.broken(
          `duplicate delivery: ${acceptedBy.length}/2 syncs reported accepted (${
            syncs.map((s) => `${s.status} ${JSON.stringify(s.body)}`).join(
              " | ",
            )
          })`,
        );
      }
      if (shotRows.length !== 1) {
        ledger.broken(
          `duplicate rows: ${shotRows.length} shot rows for one id`,
        );
      }
      if (scored !== 1) {
        ledger.broken(
          `double spend: ${scored} scored ratings for one shot`,
        );
      }
      if (permit?.status !== "finalized") {
        ledger.broken(
          `permit ${permit?.status} after accepted sync`,
        );
      }
      if (db.version !== 1) {
        ledger.broken(
          `DB moved ${db.version} times for one shot`,
        );
      }

      // cache coherence: reads starting after the FIRST accepting sync returned.
      // An isolate that held the rank in L1 BEFORE the sync (warmed, or a read
      // that completed pre-sync) keeps that copy ≤ 60 s — pinned [defect]
      // (cache.test.ts cross-isolate cacheDel) → DOCUMENTED. The sync isolate
      // itself, and any isolate that had NO pre-sync copy, can only be stale by
      // reading a stale row back out of L2 → BROKEN.
      const tSynced = Math.min(...acceptedBy.map((s) => s.tEnd));
      const expected = 7 + db.version;
      const syncIsoIds = new Set(
        acceptedBy.length ? syncIsos.map((i) => i.id) : [],
      );
      const preSyncCopy = new Set<number>(warmed);
      for (const r of rankReads) if (r.tEnd < tSynced) preSyncCopy.add(r.iso);
      const tSyncStart = Math.min(...acceptedBy.map((s) => s.tStart));
      const classifyStale = (iso: number, what: string) => {
        if (syncIsoIds.has(iso)) {
          const overlapping = rankReads.some((x) =>
            x.iso === iso && x.tStart < tSynced && x.tEnd > tSyncStart
          );
          if (overlapping) {
            ledger.broken(
              `same-isolate lost invalidation: ${what} (this isolate ran the accepting sync + cacheDel while a GET /v1/rank read-through was in flight; cache.ts:117-131)`,
              "C7m",
            );
          } else {ledger.broken(
              `same-isolate lost invalidation: ${what} (this isolate ran the accepting sync + cacheDel; row read back out of L2; cache.ts:319-349)`,
              "C2m",
            );}
        } else if (!preSyncCopy.has(iso)) {
          ledger.broken(
            `cross-isolate stale: ${what} (isolate had no pre-sync L1 copy — stale row read back from L2, or coalesced onto a pre-sync build; Redis healthy; cache.ts:319-349)`,
            "C2m",
          );
        } else {
          ledger.documented(
            `${what} — pre-sync L1 copy ages out within 60 s (cache.test.ts [defect] cross-isolate cacheDel)`,
          );
        }
      };
      for (const r of rankReads) {
        if (r.status !== 200) {
          ledger.broken(`GET /v1/rank on iso ${r.iso} → ${r.status}`);
          continue;
        }
        if (r.tStart > tSynced && r.rating !== expected) {
          classifyStale(
            r.iso,
            `iso ${r.iso} served rating ${r.rating} ${
              (r.tStart - tSynced).toFixed(2)
            } ms after POST /v1/shots:sync returned 200 (DB rating ${expected})`,
          );
        }
      }
      // settle: L2 must be clean or current; every isolate re-read
      const l2 = world.redis.get(`rank:${sub}`);
      if (l2 !== null && !l2.includes(`"rating":${expected}`)) {
        ledger.broken(
          `post: L2 holds a stale rank payload after settle: ${l2}`,
        );
      }
      for (const iso of isos) {
        const res = await timed(
          iso.handler,
          edgeRequest("GET", "/v1/rank", { token, ip }),
        );
        const rating =
          (res.body.rank as Record<string, unknown> | null)?.rating ?? null;
        if (rating !== expected) {
          classifyStale(
            iso.id,
            `post: iso ${iso.id} serves rating ${rating} after settle, DB is ${expected}`,
          );
        }
      }
      ledger.count("redis.requests", world.redis.requests);
      ledger.count(
        "supabase.calls",
        world.upstream.filter((u) => !u.url.includes("upstash")).length,
      );
      if (ledger.outcome() !== "HELD") {
        // replayable timeline (ms relative to the accepting sync's return)
        const rel = (t: number) => Number((t - tSynced).toFixed(2));
        inputs.timeline = [
          ...syncs.map((s) => ({
            t: rel(s.tStart),
            tEnd: rel(s.tEnd),
            what: `POST /v1/shots:sync → ${s.status}`,
          })),
          ...rankReads.map((r) => ({
            t: rel(r.tStart),
            tEnd: rel(r.tEnd),
            what: `GET /v1/rank iso ${r.iso} → rating ${r.rating}`,
          })),
          ...world.redis.log
            .filter((e) => e.commands.some((c) => c.includes(`rank:${sub}`)))
            .map((e) => ({
              t: rel(e.tStart),
              tEnd: rel(e.tEnd),
              what: `redis ${e.commands.join("; ").replaceAll(sub, "<uid>")}`,
            })),
        ].sort((a, b) => a.tEnd - b.tEnd);
      }
    },
  );
  assertEquals(table.summary.brokenUnpinned, 0, unpinnedBrokenSeeds(table));
});

Deno.test("stress harness: restore process globals", () => {
  restoreGlobals();
});
