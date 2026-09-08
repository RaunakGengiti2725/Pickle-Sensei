// W11-01 adversary — the auth-failure budget primitives in rateLimit.ts
// (chargeAuthFailure / peekAuthFailureBudget / peekAuthFailureShard) attacked
// in isolated module instances: process restart, Redis outage, corrupt/partial
// persisted state, clock rollback, concurrency at the shard cap, memory-table
// saturation and identity boundary values. Candidate 7cbb268a.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_w11_01_nat_budget_limiter.test.ts

import { assert, assertEquals } from "@std/assert";
import { configureRedis, fakeUpstash, loadIsolate, type RateLimitModule } from "./harness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
/** Mirrors MEMORY_WINDOW_MAX in rateLimit.ts. */
const MEMORY_WINDOW_MAX = 20_000;
/** Mirrors AUTH_FAILURE_SHARD_CAP in rateLimit.ts. */
const SHARD_CAP_FACTOR = 2;

type Budget = { limit: number; windowSeconds: number };

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;

const egressSpent = async (rl: RateLimitModule, ip: string, budget: Budget) =>
  spent(await rl.peekRateLimit("authfail", ip, budget.limit, budget.windowSeconds));

const shardSpent = async (rl: RateLimitModule, ip: string, identity: string, budget: Budget) =>
  spent(
    await rl.peekRateLimit("authfail_id", `${ip}:${identity}`, budget.limit, budget.windowSeconds),
  );

/** Pins Date.now() 1 s into a fresh aligned bucket of `windowSeconds`. */
function pinnedClock(windowSeconds: number) {
  const realNow = Date.now;
  const bucketMs = windowSeconds * 1_000;
  let now = Math.floor(realNow() / bucketMs) * bucketMs + 1_000;
  Date.now = () => now;
  return {
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

/** The handler's gate + charge sequence for one refusal of `identity`. */
async function refuse(
  rl: RateLimitModule,
  ip: string,
  identity: string | null,
  kind: "credential" | "liveness" | "expired",
  budget: Budget,
): Promise<boolean> {
  const gate = await rl.peekAuthFailureBudget(ip, identity, budget);
  if (!gate.allowed) return false;
  await rl.chargeAuthFailure(ip, identity, kind, budget);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 8 — process death / restart with the shared store present: a venue
// closed by 30 distinct credential refusals must stay closed in a fresh
// isolate (new process), and a replayed credential's shard must stay spent.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-8 restart with Redis: closed egress and spent shard survive a new isolate",
  async () => {
    configureRedis(true);
    const upstash = fakeUpstash();
    try {
      const a = (await loadIsolate()).rateLimit;
      const ip = "192.0.2.8";
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        assert(await refuse(a, ip, `forged-${i}`, "credential", AUTH_FAILURE_LIMIT));
      }
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        await a.chargeAuthFailure("192.0.2.9", "replayed", "credential", AUTH_FAILURE_LIMIT);
      }
      const b = (await loadIsolate()).rateLimit; // the process restarted
      assertEquals(
        {
          egressClosed: !(await b.peekAuthFailureBudget(ip, "forged-new", AUTH_FAILURE_LIMIT))
            .allowed,
          credentialLessClosed: !(await b.peekAuthFailureBudget(ip, null, AUTH_FAILURE_LIMIT))
            .allowed,
          shardClosed: !(await b.peekAuthFailureShard("192.0.2.9", "replayed", AUTH_FAILURE_LIMIT))
            .allowed,
          peerOpen: (await b.peekAuthFailureBudget("192.0.2.9", "peer", AUTH_FAILURE_LIMIT))
            .allowed,
        },
        { egressClosed: true, credentialLessClosed: true, shardClosed: true, peerOpen: true },
      );
    } finally {
      upstash.restore();
      configureRedis(false);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 9 — network failure mid-window: Redis answers 5xx / hangs / errors per
// command / truncates replies. The limiter must not crash, must not deny
// valid peers, and once Redis is back the budget it recorded must be intact.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-9 Redis failure modes mid-window: no crash, peers admitted, recorded budget intact after recovery",
  async () => {
    configureRedis(true);
    const upstash = fakeUpstash();
    try {
      const rl = (await loadIsolate()).rateLimit;
      const ip = "192.0.2.19";
      for (let i = 0; i < 10; i += 1) {
        assert(await refuse(rl, ip, `forged-${i}`, "credential", AUTH_FAILURE_LIMIT));
      }
      assertEquals(await egressSpent(rl, ip, AUTH_FAILURE_LIMIT), 10);

      const modes: Array<[string, () => void]> = [
        ["http 500", () => (upstash.failStatus = 500)],
        ["http 429", () => (upstash.failStatus = 429)],
        ["command error", () => (upstash.commandError = () => "ERR max requests limit exceeded")],
        ["short reply", () => (upstash.truncateRepliesTo = 1)],
      ];
      for (const [label, inject] of modes) {
        inject();
        // Charging and peeking during the outage must not throw and must not
        // lock the venue: memory fallback carries the failures per isolate.
        const admitted = await refuse(rl, ip, `during-${label}`, "credential", AUTH_FAILURE_LIMIT);
        assertEquals(
          admitted,
          true,
          `${label}: a fresh credential is judged, not refused pre-auth`,
        );
        assertEquals(
          (await rl.peekAuthFailureBudget("192.0.2.20", "peer", AUTH_FAILURE_LIMIT)).allowed,
          true,
          `${label}: unrelated egress admitted`,
        );
        upstash.failStatus = null;
        upstash.commandError = null;
        upstash.truncateRepliesTo = null;
      }
      // After recovery the limiter must read back exactly what Redis holds: the
      // 10 clean refusals plus any outage-time INCR that executed server-side
      // before its reply was lost (the short-reply case) — never fewer (lost
      // refusals) and never a fabricated count. Failures that never reached
      // Redis (5xx/429/command error) live in this isolate's memory only —
      // documented fail-open, so they are absent here by design.
      const bucket = Math.floor(Date.now() / (AUTH_FAILURE_LIMIT.windowSeconds * 1_000));
      const stored = Number(upstash.store.get(`rl:authfail:${bucket}:${ip}`)?.value);
      const readBack = await egressSpent(rl, ip, AUTH_FAILURE_LIMIT);
      assertEquals(readBack, stored, "peek reads the shared counter, not a stale local copy");
      assert(readBack >= 10 && readBack <= 10 + modes.length, `recovered egress count ${readBack}`);
    } finally {
      upstash.restore();
      configureRedis(false);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 10 — corrupt / partial persisted state: shard, tally and egress keys
// holding non-numeric, negative, float, huge or empty values. Nothing may
// throw, no valid peer may be denied, and a refusal must still be recorded
// somewhere (memory) rather than silently dropped.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-10 corrupt Redis counters (garbage, negative, float, 2^63, empty) never throw or deny peers",
  async () => {
    configureRedis(true);
    const upstash = fakeUpstash();
    const clock = pinnedClock(AUTH_FAILURE_LIMIT.windowSeconds);
    try {
      const rl = (await loadIsolate()).rateLimit;
      const ip = "192.0.2.30";
      const bucket = Math.floor(clock.now / (AUTH_FAILURE_LIMIT.windowSeconds * 1_000));
      const key = (scope: string, subject: string) => `rl:${scope}:${bucket}:${subject}`;
      const poison = ["garbage", "-5", "3.7", "9223372036854775808", "", "1e3", "NaN"];
      for (const [i, value] of poison.entries()) {
        const identity = `victim-${i}`;
        upstash.store.set(key("authfail_id", `${ip}:${identity}`), { value, expiresAtMs: null });
        upstash.store.set(key("authfail_shards", ip), { value, expiresAtMs: null });
        upstash.store.set(key("authfail", ip), { value, expiresAtMs: null });
        assertEquals(
          upstash.store.get(key("authfail", ip))?.value,
          value,
          "the poisoned key is the one the limiter reads",
        );
        const gate = await rl.peekAuthFailureBudget(ip, identity, AUTH_FAILURE_LIMIT);
        assertEquals(
          gate.allowed,
          true,
          `poison ${JSON.stringify(value)}: corrupt counter fails open`,
        );
        await rl.chargeAuthFailure(ip, identity, "credential", AUTH_FAILURE_LIMIT);
        assert(
          upstash.commands.some(
            (cmd) => String(cmd[0]) === "GET" && cmd[1] === key("authfail", ip),
          ),
          "the limiter consulted the poisoned egress counter",
        );
        const after = await rl.peekAuthFailureShard(ip, identity, AUTH_FAILURE_LIMIT);
        assert(
          Number.isFinite(after.remaining),
          `poison ${JSON.stringify(value)}: finite remaining`,
        );
        assertEquals(
          (await rl.peekAuthFailureBudget("192.0.2.31", "peer", AUTH_FAILURE_LIMIT)).allowed,
          true,
          `poison ${JSON.stringify(value)}: unrelated egress unaffected`,
        );
      }
    } finally {
      clock.restore();
      upstash.restore();
      configureRedis(false);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 11 — clock: rollback and far-future jumps. A spent shard must not be
// resurrected by a clock stepping back within its window; a jump forward past
// the window must free the venue (bounded lockout); Retry-After stays sane.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-11 clock rollback inside the window keeps a spent shard spent; a jump past the window frees the venue",
  async () => {
    configureRedis(false);
    const clock = pinnedClock(AUTH_FAILURE_LIMIT.windowSeconds);
    try {
      const rl = (await loadIsolate()).rateLimit;
      const ip = "192.0.2.40";
      clock.advance(200_000); // 201 s into the bucket
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        assert(await refuse(rl, ip, "replayed", "credential", AUTH_FAILURE_LIMIT));
      }
      const closed = await rl.peekAuthFailureShard(ip, "replayed", AUTH_FAILURE_LIMIT);
      assertEquals(closed.allowed, false);
      assert(
        closed.retryAfterSeconds >= 1 && closed.retryAfterSeconds <= 300,
        `retryAfter ${closed.retryAfterSeconds}`,
      );

      clock.advance(-150_000); // NTP rolls the isolate clock back 150 s (same bucket)
      const rolledBack = await rl.peekAuthFailureShard(ip, "replayed", AUTH_FAILURE_LIMIT);
      assertEquals(rolledBack.allowed, false, "clock rollback must not reopen the shard");
      assert(rolledBack.retryAfterSeconds >= 1 && rolledBack.retryAfterSeconds <= 300);
      assertEquals(
        (await rl.peekAuthFailureBudget(ip, "peer", AUTH_FAILURE_LIMIT)).allowed,
        true,
        "the peer never depended on the clock",
      );

      clock.advance(10 * 365 * 24 * 3600 * 1_000); // far-future jump: the window is long gone
      assertEquals(
        (await rl.peekAuthFailureShard(ip, "replayed", AUTH_FAILURE_LIMIT)).allowed,
        true,
      );
      assertEquals((await rl.peekAuthFailureBudget(ip, null, AUTH_FAILURE_LIMIT)).allowed, true);
      // And the limiter still counts in the new epoch.
      await rl.chargeAuthFailure(ip, "replayed", "credential", AUTH_FAILURE_LIMIT);
      assertEquals(await shardSpent(rl, ip, "replayed", AUTH_FAILURE_LIMIT), 1);
    } finally {
      clock.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 12 — concurrency at the shard cap: a burst of distinct liveness
// refusals arriving together all read the tally before any of them writes it.
// Overshoot must be bounded by the burst (documented) and — the part that
// matters — the egress must stay at 0 for liveness and a later credential
// replay must still charge the egress at most once while a shard exists.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-12 concurrent liveness burst at the cap: bounded overshoot, egress untouched, same-credential burst charges once",
  async () => {
    configureRedis(false);
    const rl = (await loadIsolate()).rateLimit;
    const budget = { limit: 5, windowSeconds: 300 };
    const cap = SHARD_CAP_FACTOR * budget.limit;
    const ip = "192.0.2.50";
    const burst = 40;
    await Promise.all(
      Array.from({ length: burst }, (_, i) =>
        rl.chargeAuthFailure(ip, `gone-${i}`, "liveness", budget),
      ),
    );
    let opened = 0;
    for (let i = 0; i < burst; i += 1) opened += await shardSpent(rl, ip, `gone-${i}`, budget);
    assert(
      opened >= cap && opened <= burst,
      `opened ${opened} shards (cap ${cap}, burst ${burst})`,
    );
    assertEquals(await egressSpent(rl, ip, budget), 0, "liveness never charges the egress");

    // Conservation: one credential refused 20× concurrently (mixed kinds) is one
    // venue-wide failure, and its own shard counts every refusal.
    const ip2 = "192.0.2.51";
    const wide = { limit: 25, windowSeconds: 300 }; // wide enough that `spent` does not saturate
    await Promise.all([
      ...Array.from({ length: 10 }, () => rl.chargeAuthFailure(ip2, "dead", "credential", wide)),
      ...Array.from({ length: 10 }, () => rl.chargeAuthFailure(ip2, "dead", "liveness", wide)),
    ]);
    assertEquals(
      { egress: await egressSpent(rl, ip2, wide), shard: await shardSpent(rl, ip2, "dead", wide) },
      { egress: 1, shard: 20 },
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 13 — memory-fallback saturation via credential shards. Every distinct
// refused credential opens TWO window keys (shard + credential ordinal) plus
// the tally; 30 refusals per egress therefore cost ~62 keys. A few hundred
// source addresses (trivial over IPv6) fill the 20 000-entry table and the
// limiter then fails CLOSED for every unrelated client on the isolate.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-13 memory fallback: 30 credential refusals × N egresses must not fill the table and deny unrelated clients",
  async () => {
    configureRedis(false);
    const rl = (await loadIsolate()).rateLimit;
    assertEquals((await rl.enforceRateLimit("user", "player-inside", 240, 60)).allowed, true);
    let egresses = 0;
    let refusals = 0;
    let tableFull = false;
    // Each egress: 30 distinct refused credentials, exactly what a 30-limit
    // budget admits. Stop the moment the limiter starts refusing the attacker
    // itself pre-auth (the table is full and it fails closed) or when far more
    // egresses than the whole IPv4 /16 of a venue ISP have been used.
    while (!tableFull && egresses < MEMORY_WINDOW_MAX) {
      const ip = `2001:db8::${(egresses >> 16).toString(16)}:${(egresses & 0xffff).toString(16)}`;
      egresses += 1;
      await rl.enforceRateLimit("ip", ip, 1_200, 60); // the per-IP pre-auth window every request opens
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        if (!(await refuse(rl, ip, `forged-${egresses}-${i}`, "credential", AUTH_FAILURE_LIMIT))) {
          tableFull = true; // a fresh credential from a fresh egress refused pre-auth
          break;
        }
        refusals += 1;
      }
    }
    const observed = {
      tableFull,
      egressesNeeded: egresses,
      refusals,
      newcomerAuthGate: (await rl.peekAuthFailureBudget("203.0.113.77", null, AUTH_FAILURE_LIMIT))
        .allowed,
      newcomerIpBudget: (await rl.enforceRateLimit("ip", "203.0.113.77", 1_200, 60)).allowed,
      signedInUserBudget: (await rl.enforceRateLimit("user", "player-next-minute", 240, 60))
        .allowed,
      existingUserBudget: (await rl.enforceRateLimit("user", "player-inside", 240, 60)).allowed,
    };
    assertEquals(
      { ...observed, egressesNeeded: 0, refusals: 0 },
      {
        tableFull: false,
        egressesNeeded: 0,
        refusals: 0,
        newcomerAuthGate: true,
        newcomerIpBudget: true,
        signedInUserBudget: true,
        existingUserBudget: true,
      },
      `${observed.refusals} credential refusals over only ${observed.egressesNeeded} egresses filled the window table`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 14 — identity boundary values: whitespace-only, NBSP-padded, 1 MiB
// and non-string-ish credentials. Equivalence must follow what Auth would see
// (trimmed) and nothing may throw or collapse distinct credentials together.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-14 authFailureIdentity boundaries: blank → null, padding-equivalent, 1 MiB hashed, distinct stay distinct",
  async () => {
    configureRedis(false);
    const rl = (await loadIsolate()).rateLimit;
    const { authFailureIdentity } = rl;
    assertEquals(await authFailureIdentity(""), null);
    assertEquals(await authFailureIdentity("   \t\n"), null);
    assertEquals(await authFailureIdentity("\u00a0\u2003"), null, "unicode whitespace only");
    const plain = await authFailureIdentity("token-x");
    assert(plain !== null && /^[0-9a-f]{32}$/.test(plain));
    assertEquals(
      await authFailureIdentity("  token-x  "),
      plain,
      "ASCII padding is the same credential",
    );
    assertEquals(
      await authFailureIdentity("\u00a0token-x\u00a0"),
      plain,
      "NBSP padding is the same credential",
    );
    assert(
      (await authFailureIdentity("token-x.")) !== plain,
      "one extra byte is a different credential",
    );
    const huge = "A".repeat(1 << 20);
    const hugeId = await authFailureIdentity(huge);
    assert(hugeId !== null && hugeId.length === 32);
    assert((await authFailureIdentity(huge + "B")) !== hugeId);
    // A refusal kind the classifier has never heard of must be the strict
    // (credential) kind — never silently promoted to a free liveness refusal.
    assertEquals(rl.authRefusalKind("totally_new_code"), "credential");
    assertEquals(rl.authRefusalKind(undefined), "credential");
    assertEquals(rl.authRefusalKind(null), "credential");
    assertEquals(rl.authRefusalKind("session_not_found"), "liveness");
  },
);
