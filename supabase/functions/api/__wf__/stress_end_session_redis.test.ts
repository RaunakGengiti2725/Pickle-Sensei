/**
 * stress — POST /v1/sessions/:id/finalize (end session): UPSTASH REDIS FAULTS.
 *
 * Same real handler, but this isolate boots with UPSTASH_REDIS_REST_URL/TOKEN
 * set (cache.ts reads them at module load), so every auth-cache read, rate-
 * limit window and revocation check goes through the modelled Upstash
 * /pipeline endpoint — which is then made to fail / time out / answer
 * malformed, in turn. Contract under test (cache.ts header comment):
 * Redis UNREACHABLE degrades to L1/memory and must never sign users out or
 * fail the request; Redis REACHED-but-nonsense re-verifies with the source
 * of truth; a revocation marker fences even an L1 hit.
 *
 * Deterministic from STRESS_SEED. Table: artifacts/stress-end-session/latest/redis_faults.json.
 *
 *   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_end_session_redis.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import {
  classifyResponse,
  type ErrorClass,
  type FaultAction,
  finalizeRequest,
  loadStressHarness,
  Prng,
  replayCommand,
  STRESS_SEED,
  type StressHarness,
  writeJson,
} from "./stress_end_session_harness.ts";

const FILE = "stress_end_session_redis.test.ts";
const REDIS_TIMEOUT_MS = 1_200; // cache.ts REDIS_TIMEOUT_MS

interface Row {
  id: string;
  seed: number;
  fault: string;
  expected: { status: number; outbox: ErrorClass["outbox"] };
  observed: ErrorClass & {
    durationMs: number;
    redisCalls: number;
    authCalls: number;
    pgCalls: number;
    upstreamCalls: Record<string, number>;
  };
  recovery: null | { status: number; redisCalls: number; endedAtStampedOnce: boolean };
  verdict: "HELD" | "BROKEN";
  notes: string[];
  replay: string;
}

interface Scenario {
  id: string;
  fault: string;
  install: (
    h: StressHarness,
    ctx: {
      token: string;
      user: string;
      sessionClaim: string;
      cacheKey: string;
      otherToken: string;
      otherUser: string;
    },
  ) => unknown;
  expected: Row["expected"];
  /** warm the auth cache (one healthy request) before installing the fault */
  warm?: boolean;
  /** use the OTHER user's session id in the path */
  otherSession?: boolean;
  extra?: (row: Row["observed"], h: StressHarness) => string[];
  recover?: boolean;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const always = (a: FaultAction) => (): FaultAction => a;
const once =
  (a: FaultAction) =>
  ({ n }: { n: number }): FaultAction =>
    n === 1 ? a : { kind: "pass" };
const raw = (status: number, text: string, contentType = "application/json"): FaultAction => ({
  kind: "raw",
  status,
  text,
  contentType,
});

/** Answer every pipeline command with the same slot. */
const slotsOf =
  (slot: unknown) =>
  ({ call }: { call: { body: unknown } }): FaultAction => {
    const n = Array.isArray(call.body) ? call.body.length : 1;
    return { kind: "status", status: 200, body: Array.from({ length: n }, () => slot) };
  };

const scenarios: Scenario[] = [
  {
    id: "R00-control-cold",
    fault: "none",
    install: () => {},
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R01-control-warm",
    fault: "none (auth cached in L1+L2)",
    warm: true,
    install: () => {},
    expected: { status: 200, outbox: "success" },
    extra: (o) =>
      o.authCalls === 0 ? [] : [`warm request re-verified with Auth (${o.authCalls})`],
  },
  {
    id: "R02-redis-500",
    fault: "HTTP 500",
    install: (h) => (h.faults.redis = always({ kind: "status", status: 500 })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R03-redis-401",
    fault: "HTTP 401 (bad token)",
    install: (h) =>
      (h.faults.redis = always({ kind: "status", status: 401, body: { error: "Unauthorized" } })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R04-redis-429",
    fault: "HTTP 429 (Upstash quota)",
    install: (h) =>
      (h.faults.redis = always({
        kind: "status",
        status: 429,
        body: { error: "ERR max requests limit exceeded" },
      })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R05-redis-503",
    fault: "HTTP 503",
    install: (h) => (h.faults.redis = always({ kind: "status", status: 503 })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R06-redis-200-object",
    fault: "200 {} (not an array)",
    install: (h) => (h.faults.redis = always({ kind: "status", status: 200, body: {} })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R07-redis-200-empty-array",
    fault: "200 [] (short reply)",
    install: (h) => (h.faults.redis = always({ kind: "status", status: 200, body: [] })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R08-redis-200-errors",
    fault: "200 [{error:WRONGTYPE}…]",
    install: (h) =>
      (h.faults.redis = slotsOf({
        error: "WRONGTYPE Operation against a key holding the wrong kind of value",
      })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R09-redis-200-html",
    fault: "200 text/html",
    install: (h) => (h.faults.redis = always(raw(200, "<html>gateway</html>", "text/html"))),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R10-redis-200-nulls",
    fault: "200 [null,…]",
    install: (h) => (h.faults.redis = slotsOf(null)),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R11-redis-200-garbage-strings",
    fault: "200 [{result:'garbage'}…] (INCR→string, GET→non-JSON)",
    install: (h) => (h.faults.redis = slotsOf({ result: "garbage" })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R11b-redis-marker-slot-string-once",
    fault: "ONE pipeline answers a string in slot 0 (GET auth:revoked:*), then healthy",
    warm: true,
    install: (h) => {
      let fired = false;
      h.faults.redis = ({ call }) => {
        const cmds = Array.isArray(call.body) ? (call.body as Array<Array<string>>) : [];
        if (!fired && cmds[0]?.[0] === "GET" && String(cmds[0][1]).startsWith("auth:revoked:")) {
          fired = true;
          return {
            kind: "status",
            status: 200,
            body: cmds.map((_, i) => (i === 0 ? { result: "x" } : { result: null })),
          };
        }
        return { kind: "pass" };
      };
    },
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R12-redis-incr-huge",
    fault: "200 [{result:1e9}…] (every window over budget)",
    install: (h) => (h.faults.redis = slotsOf({ result: 1_000_000_000 })),
    expected: { status: 429, outbox: "retry" },
    extra: (o) => (o.retryAfter ? [] : ["429 without Retry-After"]),
    recover: false,
  },
  {
    id: "R13-redis-hang",
    fault: `hang > ${REDIS_TIMEOUT_MS}ms on EVERY call`,
    install: (h) => (h.faults.redis = always({ kind: "hang", maxMs: 5_000 })),
    expected: { status: 200, outbox: "success" },
    extra: (o) =>
      o.durationMs < o.redisCalls * REDIS_TIMEOUT_MS * 1.5 + 200
        ? []
        : [`hang path took ${o.durationMs}ms for ${o.redisCalls} Redis calls`],
  },
  {
    id: "R14-redis-socket",
    fault: "socket error",
    install: (h) =>
      (h.faults.redis = always({
        kind: "throw",
        message: "error sending request: connection refused",
      })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R15-redis-slow-300",
    fault: "delay 300ms (under timeout) on every call",
    install: (h) => (h.faults.redis = always({ kind: "delay", ms: 300 })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R16-redis-500-once",
    fault: "HTTP 500 on first call only",
    install: (h) => (h.faults.redis = once({ kind: "status", status: 500 })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R17-redis-hang-once",
    fault: "hang on first call only",
    install: (h) => (h.faults.redis = once({ kind: "hang", maxMs: 5_000 })),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R18-revocation-marker",
    fault: "L2 holds auth:revoked:<session_id> (logout on another device)",
    warm: true,
    install: (h, ctx) => {
      h.redis.set(`auth:revoked:${ctx.sessionClaim}`, {
        value: "1",
        expiresAtMs: Date.now() + 600_000,
      });
    },
    expected: { status: 401, outbox: "retry" },
    extra: (o) => (o.authCalls === 0 ? [] : ["revoked bearer still reached Supabase Auth"]),
    recover: false,
  },
  {
    id: "R19-l2-row-gone",
    fault: "L1 warm, L2 lost the row (TTL -2) → must re-verify",
    warm: true,
    install: (h, ctx) => {
      h.redis.delete(ctx.cacheKey);
    },
    expected: { status: 200, outbox: "success" },
    extra: (o) =>
      o.authCalls === 1 ? [] : [`expected exactly one re-verification, got ${o.authCalls}`],
  },
  {
    id: "R20-l2-corrupt-entry",
    fault: "L2 auth entry for this (L1-unknown) bearer is not JSON",
    install: (h, ctx) => {
      h.redis.set(ctx.cacheKey, { value: "{not json", expiresAtMs: Date.now() + 600_000 });
    },
    expected: { status: 200, outbox: "success" },
    extra: (o) =>
      o.authCalls === 1
        ? []
        : [`corrupt L2 entry must fall through to one real verification, got ${o.authCalls}`],
  },
  {
    id: "R21-l2-entry-other-user",
    fault: "L2 auth entry for this bearer names ANOTHER user (poisoned L2, bearer unknown to L1)",
    otherSession: true,
    install: (h, ctx) => {
      // A fresh bearer (never seen by L1) whose L2 row claims the other user.
      h.redis.set(ctx.cacheKey, {
        value: JSON.stringify({
          userId: ctx.otherUser,
          email: "other@example.com",
          provider: "google",
          accessToken: ctx.otherToken,
          expiresAtMs: Date.now() + 500_000,
        }),
        expiresAtMs: Date.now() + 600_000,
      });
    },
    expected: { status: 200, outbox: "success" },
    extra: (o) => (o.authCalls === 0 ? [] : ["poisoned L2 entry was not trusted (re-verified)"]),
    recover: false,
  },
  {
    id: "R22-redis-partial-reply",
    fault: "200 with one slot fewer than commands",
    install: (h) =>
      (h.faults.redis = ({ call }) => {
        const n = Array.isArray(call.body) ? call.body.length : 1;
        return {
          kind: "status",
          status: 200,
          body: Array.from({ length: Math.max(0, n - 1) }, () => ({ result: null })),
        };
      }),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R23-redis-set-fails-reads-ok",
    fault: "SET pipelines → 500, reads healthy",
    install: (h) =>
      (h.faults.redis = ({ call }) => {
        const cmds = Array.isArray(call.body) ? (call.body as Array<Array<string>>) : [];
        return cmds.some((c) => c[0] === "SET")
          ? { kind: "status", status: 500 }
          : { kind: "pass" };
      }),
    expected: { status: 200, outbox: "success" },
  },
  {
    id: "R24-redis-and-auth-down",
    fault: "Redis 500 + Supabase Auth 503",
    install: (h) => {
      h.faults.redis = always({ kind: "status", status: 500 });
      h.faults.auth_get_user = always({ kind: "status", status: 503 });
    },
    expected: { status: 503, outbox: "retry" },
  },
  {
    id: "R25-redis-hang-auth-warm",
    fault: "Redis hangs, auth warm in L1 — served from L1 after timeouts",
    warm: true,
    install: (h) => (h.faults.redis = always({ kind: "hang", maxMs: 5_000 })),
    expected: { status: 200, outbox: "success" },
    extra: (o) => (o.authCalls === 0 ? [] : ["L1 hit not used while Redis unreachable"]),
  },
];

const rows: Row[] = [];

async function run(h: StressHarness, prng: Prng, s: Scenario): Promise<Row> {
  h.reset();
  const user = h.mintUser(prng);
  const other = h.mintUser(prng);
  const sessionClaim = prng.uuid();
  const token = h.mintBearer(user.id, { sessionId: sessionClaim });
  const otherToken = h.mintBearer(other.id);
  const own = h.mintSession(prng, user.id);
  const theirs = h.mintSession(prng, other.id);
  const cacheKey = `auth:${await sha256Hex(token)}`;
  const notes: string[] = [];
  if (s.warm) {
    const w = await h.invoke(
      finalizeRequest(h.mintSession(prng, user.id, "2026-09-01T11:00:00.000Z").id, { token }),
      `${s.id}-warm`,
    );
    await w.text();
    if (w.status !== 200) notes.push(`warm-up returned ${w.status}`);
  }
  h.resetFaults();
  await s.install(h, {
    token,
    user: user.id,
    sessionClaim,
    cacheKey,
    otherToken,
    otherUser: other.id,
  });
  const target = s.otherSession ? theirs : own;
  const rid = `${s.id}-1`;
  const t0 = performance.now();
  const response = await h.invoke(
    finalizeRequest(target.id, { token, ip: `192.0.2.${prng.int(1, 250)}` }),
    rid,
  );
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  const cls = await classifyResponse(response);
  const calls = h.callsFor(rid);
  const upstreamCalls: Record<string, number> = {};
  for (const c of calls)
    upstreamCalls[`${c.kind}:${c.action}`] = (upstreamCalls[`${c.kind}:${c.action}`] ?? 0) + 1;
  const observed: Row["observed"] = {
    ...cls,
    durationMs,
    redisCalls: calls.filter((c) => c.kind === "redis").length,
    authCalls: calls.filter((c) => c.kind === "auth_get_user").length,
    pgCalls: calls.filter((c) => c.kind.startsWith("pg_")).length,
    upstreamCalls,
  };
  let verdict: Row["verdict"] = "HELD";
  if (observed.status !== s.expected.status) {
    verdict = "BROKEN";
    notes.push(`status ${observed.status} != expected ${s.expected.status}`);
  }
  if (observed.outbox !== s.expected.outbox) {
    verdict = "BROKEN";
    notes.push(`outbox ${observed.outbox} != expected ${s.expected.outbox}`);
  }
  if (observed.leaksDetail) {
    verdict = "BROKEN";
    notes.push(`5xx leaks detail: ${observed.message}`);
  }
  if (!observed.requestId) {
    verdict = "BROKEN";
    notes.push("missing x-request-id");
  }
  if (calls.some((c) => c.kind === "revenuecat")) {
    verdict = "BROKEN";
    notes.push("route reached RevenueCat");
  }
  if (s.extra) {
    const e = s.extra(observed, h);
    if (e.length) {
      verdict = "BROKEN";
      notes.push(...e);
    }
  }
  if (s.id === "R21-l2-entry-other-user") {
    notes.push(
      `by design: L2 is a trusted store (Upstash token = trust boundary); the poisoned row made the route act as the other user (their session ended_at=${theirs.ended_at !== null}). Not a finding unless Redis is compromised.`,
    );
  }
  let recovery: Row["recovery"] = null;
  if (s.recover !== false) {
    h.resetFaults();
    const before = own.ended_at;
    const r2 = await h.invoke(finalizeRequest(own.id, { token }), `${s.id}-2`);
    await r2.text();
    const a1 = own.ended_at;
    const r3 = await h.invoke(finalizeRequest(own.id, { token }), `${s.id}-3`);
    await r3.text();
    const a2 = own.ended_at;
    const stampedOnce = a1 !== null && a1 === a2 && (before === null || before === a1);
    recovery = {
      status: r2.status,
      redisCalls: h.callsFor(`${s.id}-2`).filter((c) => c.kind === "redis").length,
      endedAtStampedOnce: stampedOnce,
    };
    if (r2.status !== 200 || r3.status !== 200 || !stampedOnce) {
      verdict = "BROKEN";
      notes.push(
        `recovery ${r2.status}/${r3.status}, stampedOnce=${stampedOnce} (${before} → ${a1} → ${a2})`,
      );
    }
  }
  return {
    id: s.id,
    seed: prng.seed,
    fault: s.fault,
    expected: s.expected,
    observed,
    recovery,
    verdict,
    notes,
    replay: replayCommand(FILE, s.id, prng.seed),
  };
}

Deno.test(
  `stress/end-session redis: ${scenarios.length} Upstash fault cases (real handler, Redis-enabled isolate)`,
  async (t) => {
    const h = await loadStressHarness({ redis: true });
    const prng = new Prng(STRESS_SEED ^ 0x5ed15);
    for (const s of scenarios) {
      await t.step(s.id, async () => {
        const row = await run(h, prng, s);
        rows.push(row);
      });
    }
    const control = rows.find((r) => r.id === "R00-control-cold")!;
    const warm = rows.find((r) => r.id === "R01-control-warm")!;
    const hang = rows.find((r) => r.id === "R13-redis-hang")!;
    const summary = {
      seed: STRESS_SEED ^ 0x5ed15,
      cases: rows.length,
      held: rows.filter((r) => r.verdict === "HELD").length,
      broken: rows.filter((r) => r.verdict === "BROKEN").map((r) => r.id),
      redisRoundTripsPerRequest: {
        cold: control.observed.redisCalls,
        warm: warm.observed.redisCalls,
      },
      supabaseRoundTripsPerRequest: {
        cold: control.observed.authCalls + control.observed.pgCalls,
        warm: warm.observed.authCalls + warm.observed.pgCalls,
      },
      redisOutageLatency: {
        hangEveryCallMs: hang.observed.durationMs,
        redisCallsDuringHang: hang.observed.redisCalls,
        note: `each Redis call is bounded by ${REDIS_TIMEOUT_MS}ms and they are sequential; a total Redis outage adds ≈ redisCalls × ${REDIS_TIMEOUT_MS}ms to EVERY request while degrading correctly`,
      },
      rows,
    };
    const path = await writeJson("redis_faults", summary);
    console.log(
      `[stress/end-session redis] ${summary.held}/${rows.length} HELD → ${path}; redis RT cold/warm ${summary.redisRoundTripsPerRequest.cold}/${summary.redisRoundTripsPerRequest.warm}; hang ${hang.observed.durationMs}ms`,
    );
    assert(rows.length >= 20);
    // Reproduced, documented finding (Redis outage latency amplification) is
    // recorded in the table; every other case must HELD.
    // R11: a REACHED Redis answering a string in the revocation-marker slot is
    // taken as the marker → 401 + the marker is copied into L1 for 60s, so the
    // user stays refused after Redis is healthy again (cache.ts:177-181).
    const knownFindings = new Set<string>([
      "R11-redis-200-garbage-strings",
      "R11b-redis-marker-slot-string-once",
    ]);
    for (const id of knownFindings) {
      const row = rows.find((r) => r.id === id);
      assert(
        row && row.verdict === "BROKEN",
        `${id} is recorded as a known finding but no longer reproduces — update the table`,
      );
    }
    const unexpected = rows.filter((r) => r.verdict === "BROKEN" && !knownFindings.has(r.id));
    assertEquals(
      unexpected.map((r) => `${r.id}: ${r.notes.join("; ")}`),
      [],
    );
  },
);
