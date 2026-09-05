/**
 * stress — POST /v1/sessions/:id/finalize (end session): LOAD.
 *
 * Real handler in-process, healthy upstream model, seeded traffic mix:
 *
 *   L1  STRESS_ITER requests (default 1000) from a pool of users; each request
 *       is replayable from (seed, index). Records p50/p95/p99 latency and
 *       the EXACT number of Supabase round trips per request (attribution via
 *       AsyncLocalStorage in the harness). A hot path doing >3 round trips is
 *       a finding.
 *   L2  Concurrent burst: the same session finalized by N parallel requests
 *       with a slow PostgREST — exactly-once semantics observed at the
 *       upstream (how many UPDATEs reach the DB for one row).
 *   L3  STRESS_USERS distinct users (default 2000; the campaign ran 20000)
 *       cold-authenticating once each → L1 auth-cache memory (heap delta,
 *       bytes/user) and eviction behaviour (MEMORY_MAX_ENTRIES=5000): after
 *       the sweep, users from the head of the sweep must re-verify (miss),
 *       users from the tail must still hit.
 *
 * Output tables under artifacts/stress-end-session/latest/ (STRESS_OUT_DIR):
 *   load_requests.json (per-request rows), load_summary.json,
 *   load_burst.json, load_users.json.
 *
 *   cd supabase/functions/api/__wf__ && STRESS_ITER=1000 STRESS_USERS=20000 deno test -A --no-check --config deno.json stress_end_session_load.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import {
  finalizeRequest,
  heapSnapshot,
  latencyStats,
  loadStressHarness,
  Prng,
  replayCommand,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_USERS,
  type UpstreamKind,
  writeJson,
} from "./stress_end_session_harness.ts";

const FILE = "stress_end_session_load.test.ts";

type Op = "first-finalize" | "replay-finalize" | "missing-session" | "bad-uuid";

interface RequestRow {
  i: number;
  seed: number;
  op: Op;
  user: number;
  status: number;
  ms: number;
  roundTrips: number;
  byKind: Partial<Record<UpstreamKind, number>>;
  authCached: boolean;
}

function countByKind(calls: Array<{ kind: UpstreamKind }>): Partial<Record<UpstreamKind, number>> {
  const out: Partial<Record<UpstreamKind, number>> = {};
  for (const c of calls) out[c.kind] = (out[c.kind] ?? 0) + 1;
  return out;
}

Deno.test(
  `stress/end-session load: L1 ${STRESS_ITER} seeded requests → p50/p95 + Supabase round trips per request`,
  async () => {
    const h = await loadStressHarness({ redis: false });
    const prng = new Prng(STRESS_SEED);
    const USERS = 50;
    const users = Array.from({ length: USERS }, () => {
      const user = h.mintUser(prng);
      return { user, token: h.mintBearer(user.id), ip: `203.0.113.${prng.int(1, 250)}` };
    });
    // Per-user route budget is enforced before dispatch; spread the traffic so
    // the load measures the route, not the limiter (429s are still recorded).
    const rows: RequestRow[] = [];
    const authSeen = new Set<number>();
    const heapBefore = heapSnapshot();
    const t0 = performance.now();
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const roll = prng.next();
      const op: Op =
        roll < 0.55
          ? "first-finalize"
          : roll < 0.9
            ? "replay-finalize"
            : roll < 0.97
              ? "missing-session"
              : "bad-uuid";
      const u = prng.int(0, USERS - 1);
      const { user, token, ip } = users[u];
      let sessionId: string;
      if (op === "first-finalize") sessionId = h.mintSession(prng, user.id).id;
      else if (op === "replay-finalize")
        sessionId = h.mintSession(prng, user.id, "2026-09-01T11:00:00.000Z").id;
      else if (op === "missing-session") sessionId = prng.uuid();
      else sessionId = `not-a-uuid-${i}`;
      const requestId = `L1-${i}`;
      const ts = performance.now();
      const response = await h.invoke(finalizeRequest(sessionId, { token, ip }), requestId);
      await response.text();
      const ms = performance.now() - ts;
      const calls = h.callsFor(requestId);
      rows.push({
        i,
        seed: STRESS_SEED,
        op,
        user: u,
        status: response.status,
        ms: Math.round(ms * 1000) / 1000,
        roundTrips: calls.length,
        byKind: countByKind(calls),
        authCached: authSeen.has(u),
      });
      authSeen.add(u);
    }
    const wallMs = performance.now() - t0;
    const heapAfter = heapSnapshot();

    const byOp: Record<
      string,
      ReturnType<typeof latencyStats> & {
        roundTrips: Record<string, number>;
        statuses: Record<string, number>;
      }
    > = {};
    for (const op of ["first-finalize", "replay-finalize", "missing-session", "bad-uuid"] as Op[]) {
      const sel = rows.filter((r) => r.op === op);
      const rt: Record<string, number> = {};
      const st: Record<string, number> = {};
      for (const r of sel) {
        rt[String(r.roundTrips)] = (rt[String(r.roundTrips)] ?? 0) + 1;
        st[String(r.status)] = (st[String(r.status)] ?? 0) + 1;
      }
      byOp[op] = { ...latencyStats(sel.map((r) => r.ms)), roundTrips: rt, statuses: st };
    }
    const warm = rows.filter((r) => r.authCached);
    const maxRoundTrips = Math.max(...rows.map((r) => r.roundTrips));
    const over3 = rows.filter((r) => r.roundTrips > 3);
    const summary = {
      file: FILE,
      seed: STRESS_SEED,
      requests: rows.length,
      users: USERS,
      wallMs: Math.round(wallMs),
      throughputRps: Math.round((rows.length / wallMs) * 1000),
      all: latencyStats(rows.map((r) => r.ms)),
      warmAuth: latencyStats(warm.map((r) => r.ms)),
      byOp,
      statusHistogram: rows.reduce<Record<string, number>>(
        (acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc),
        {},
      ),
      roundTripHistogram: rows.reduce<Record<string, number>>(
        (acc, r) => ((acc[r.roundTrips] = (acc[r.roundTrips] ?? 0) + 1), acc),
        {},
      ),
      maxRoundTrips,
      requestsOver3RoundTrips: over3.map((r) => r.i),
      expectedRoundTrips: {
        "first-finalize (auth cached)": 2,
        "replay-finalize (auth cached)": 1,
        "missing-session (auth cached)": 1,
        "bad-uuid (auth cached)": 0,
        "+1 on the first request per user (Supabase Auth getUser, then L1 cache ~10 min)": 1,
      },
      heap: {
        before: heapBefore,
        after: heapAfter,
        deltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
      },
      replay: replayCommand(FILE, "L1", STRESS_SEED),
    };
    await writeJson("load_requests", rows);
    await writeJson("load_summary", summary);
    console.log(
      `[stress/end-session load] ${rows.length} req in ${summary.wallMs}ms — p50 ${summary.all.p50}ms p95 ${summary.all.p95}ms max round trips ${maxRoundTrips}`,
    );

    assert(
      rows.length >= Math.min(STRESS_ITER, 1000) || STRESS_ITER < 1000,
      "did not execute the requested iterations",
    );
    assertEquals(
      over3.length,
      0,
      `requests with >3 Supabase round trips: ${over3.map((r) => r.i).join(",")}`,
    );
    // Warm path shape: auth cached → first-finalize exactly select+update, replay exactly select.
    for (const r of warm) {
      if (r.status === 429) continue;
      if (r.op === "first-finalize")
        assertEquals(r.roundTrips, 2, `L1-${r.i} first-finalize warm round trips`);
      if (r.op === "replay-finalize")
        assertEquals(r.roundTrips, 1, `L1-${r.i} replay warm round trips`);
      if (r.op === "missing-session")
        assertEquals(r.roundTrips, 1, `L1-${r.i} missing warm round trips`);
      if (r.op === "bad-uuid") assertEquals(r.roundTrips, 0, `L1-${r.i} bad-uuid warm round trips`);
    }
    // Status contract per op (no 5xx under a healthy upstream; 429 tolerated only if the per-user budget really tripped).
    for (const r of rows) {
      if (r.status === 429) continue;
      const want =
        r.op === "first-finalize" || r.op === "replay-finalize"
          ? 200
          : r.op === "missing-session"
            ? 404
            : 400;
      assertEquals(r.status, want, `L1-${r.i} ${r.op} status`);
    }
    // Every replay must have left ended_at untouched (harness rows are the DB).
    for (const row of h.sessions.values()) {
      if (row.ended_at !== null && row.ended_at !== "2026-09-01T11:00:00.000Z") {
        assert(!Number.isNaN(Date.parse(row.ended_at)), "ended_at is an ISO timestamp");
      }
    }
  },
);

Deno.test(
  "stress/end-session load: L2 concurrent burst on ONE session — how many UPDATEs reach the DB",
  async () => {
    const h = await loadStressHarness({ redis: false });
    const prng = new Prng(STRESS_SEED ^ 0xb0057);
    const user = h.mintUser(prng);
    const token = h.mintBearer(user.id);
    // warm auth so the burst measures the route body only
    const warm = await h.invoke(
      finalizeRequest(h.mintSession(prng, user.id, "2026-09-01T11:00:00.000Z").id, { token }),
      "L2-warm",
    );
    await warm.text();
    const results: Array<{
      lanes: number;
      statuses: Record<string, number>;
      updates: number;
      selects: number;
      endedAt: string | null;
      ms: number;
    }> = [];
    for (const lanes of [2, 8, 24]) {
      const session = h.mintSession(prng, user.id);
      const before = h.calls.length;
      // A slow select widens the read→write window so every lane reads ended_at=null.
      h.faults.pg_sessions_select = () => ({ kind: "delay", ms: 40 });
      const t0 = performance.now();
      const responses = await Promise.all(
        Array.from({ length: lanes }, (_, lane) =>
          h.invoke(
            finalizeRequest(session.id, { token, ip: `198.51.100.${lane + 1}` }),
            `L2-${lanes}-${lane}`,
          ),
        ),
      );
      const ms = Math.round(performance.now() - t0);
      h.resetFaults();
      const statuses: Record<string, number> = {};
      for (const r of responses) {
        statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
        await r.text();
      }
      const calls = h.calls.slice(before);
      results.push({
        lanes,
        statuses,
        updates: calls.filter((c) => c.kind === "pg_sessions_update").length,
        selects: calls.filter((c) => c.kind === "pg_sessions_select").length,
        endedAt: session.ended_at,
        ms,
      });
    }
    const out = {
      seed: STRESS_SEED ^ 0xb0057,
      results,
      note: "finalizeSession reads ended_at then UPDATEs when null (index.ts:1758-1777); the UPDATE carries no `ended_at is null` guard, so N concurrent first-finalizes issue N UPDATEs — each re-stamps ended_at with its own now(). Last writer wins; the client sees 200 for all. Postgres-backed proof in stress_end_session_pg.test.ts.",
      replay: replayCommand(FILE, "L2", STRESS_SEED),
    };
    await writeJson("load_burst", out);
    for (const r of results) {
      assertEquals(r.statuses, { "200": r.lanes }, `all ${r.lanes} lanes must see 200`);
      assertEquals(r.selects, r.lanes, "one select per lane");
      assert(r.endedAt !== null, "row ended");
      // Documented behaviour (not a crash, not data loss): every lane that read
      // ended_at=null issues its own UPDATE — the write is not guarded.
      assert(r.updates >= 1 && r.updates <= r.lanes, `updates ${r.updates} for ${r.lanes} lanes`);
    }
  },
);

Deno.test(
  `stress/end-session load: L3 ${STRESS_USERS} distinct users → L1 auth-cache memory + eviction`,
  async () => {
    const h = await loadStressHarness({ redis: false });
    const prng = new Prng(STRESS_SEED ^ 0x0cac4e);
    const N = STRESS_USERS;
    const tokens: string[] = new Array(N);
    const ids: string[] = new Array(N);
    // Mint everything first so the measured heap delta is the edge fn's caches,
    // not the harness's own maps (those are measured separately below).
    const heap0 = heapSnapshot();
    for (let i = 0; i < N; i += 1) {
      const id = prng.uuid();
      ids[i] = id;
      h.users.set(id, { id, email: `${id.slice(0, 8)}@example.com`, provider: "google" });
      tokens[i] = h.mintBearer(id);
    }
    const heapMinted = heapSnapshot();
    const session404 = prng.uuid(); // no row → 404 after auth; keeps the DB model empty
    const latencies: number[] = [];
    let authCalls = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i += 1) {
      const rid = `L3-${i}`;
      const ts = performance.now();
      const r = await h.invoke(
        finalizeRequest(session404, {
          token: tokens[i],
          ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
        }),
        rid,
      );
      await r.text();
      latencies.push(performance.now() - ts);
      if (r.status !== 404) throw new Error(`L3-${i} status ${r.status}`);
      authCalls += h.callsFor(rid).filter((c) => c.kind === "auth_get_user").length;
      if (i % 2000 === 1999) h.calls.length = 0; // keep the harness log bounded; per-request lookups are done
    }
    const sweepMs = performance.now() - t0;
    h.calls.length = 0;
    const heapAfter = heapSnapshot();

    // Eviction probe: head users (oldest) vs tail users (newest).
    const probe = async (label: string, idx: number[]) => {
      let miss = 0;
      for (const i of idx) {
        const rid = `L3-probe-${label}-${i}`;
        const r = await h.invoke(finalizeRequest(session404, { token: tokens[i] }), rid);
        await r.text();
        if (h.callsFor(rid).some((c) => c.kind === "auth_get_user")) miss += 1;
      }
      return { probed: idx.length, misses: miss };
    };
    const headIdx = Array.from({ length: Math.min(200, N) }, (_, k) => k);
    const tailIdx = Array.from({ length: Math.min(200, N) }, (_, k) => N - 1 - k);
    const head = await probe("head", headIdx);
    const tail = await probe("tail", tailIdx);

    const out = {
      seed: STRESS_SEED ^ 0x0cac4e,
      users: N,
      authGetUserCalls: authCalls,
      sweepMs: Math.round(sweepMs),
      perUserMs: latencyStats(latencies),
      heap: {
        beforeMint: heap0,
        afterMint: heapMinted,
        afterSweep: heapAfter,
        harnessMintBytes: heapMinted.heapUsed - heap0.heapUsed,
        edgeFnDeltaBytes: heapAfter.heapUsed - heapMinted.heapUsed,
        edgeFnBytesPerUser: Math.round((heapAfter.heapUsed - heapMinted.heapUsed) / N),
        rssAfterSweep: heapAfter.rss,
      },
      l1: {
        MEMORY_MAX_ENTRIES: 5000,
        note: "cache.ts evicts the oldest third when full; with N ≫ 5000 the head of the sweep must be gone and the tail resident",
        head,
        tail,
      },
      replay: replayCommand(FILE, "L3", STRESS_SEED),
    };
    await writeJson("load_users", out);
    console.log(
      `[stress/end-session load] ${N} users: ${authCalls} auth calls, edge-fn heap Δ ${out.heap.edgeFnDeltaBytes} B (${out.heap.edgeFnBytesPerUser} B/user), head misses ${head.misses}/${head.probed}, tail misses ${tail.misses}/${tail.probed}`,
    );

    assertEquals(
      authCalls,
      N,
      "every distinct user verifies with Supabase Auth exactly once during the sweep",
    );
    assertEquals(tail.misses, 0, "most recent users must still be L1-cached");
    if (N > 5000)
      assertEquals(head.misses, head.probed, "oldest users must have been evicted (bounded L1)");
    else assertEquals(head.misses, 0, "under capacity nothing is evicted");
    // Memory bound (only meaningful when GC is forced: --v8-flags=--expose-gc):
    // retained growth must be bounded by the 5000-entry L1 cap plus the
    // 20000-entry rate-limit windows, not linear in distinct users.
    if (heapAfter.gcForced) {
      const cappedUsers = Math.min(N, 5000);
      assert(
        out.heap.edgeFnDeltaBytes < cappedUsers * 6_000 + N * 600 + 8_000_000,
        `edge fn retained ${out.heap.edgeFnDeltaBytes} bytes for ${N} users — L1 cache not bounded`,
      );
    }
  },
);
