// W11-01 adversarial tests — the sharded auth-failure budget with Upstash
// Redis CONFIGURED (the cross-isolate path the candidate's own regression
// file never exercises: rateLimit_nat_budget.test.ts runs memory-only).
//
// Each Deno.test is one attack. Attacks that the candidate survives assert
// the surviving behaviour; attacks that break it assert the CORRECT
// behaviour and therefore fail on the candidate (see the [break] tags).
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check \
//     --config deno.json attack_w11_01_nat_budget_redis.test.ts

import {
  assert,
  assertEquals,
  configureRedis,
  type FakeUpstash,
  fakeUpstash,
  loadIsolate,
  type RateLimitModule,
} from "./harness.ts";

const BUDGET = { limit: 30, windowSeconds: 300 };
const DAY_MS = 86_400_000;
const ROTATED_GRACE_MS = 3_600_000;
const MINTED_PREFIX = "authminted:v1:";

async function isolate(): Promise<RateLimitModule> {
  return (await loadIsolate()).rateLimit;
}

async function saturate(rl: RateLimitModule, egress: string): Promise<void> {
  for (let i = 0; i < BUDGET.limit; i += 1) {
    const guess = await rl.authCredentialIdentity(`guess-${egress}-${i}-${crypto.randomUUID()}`);
    assertEquals(await rl.chargeAuthFailure(egress, guess, "credential", BUDGET), "credential");
  }
  const novel = await rl.authCredentialIdentity(`novel-${crypto.randomUUID()}`);
  assertEquals(
    (await rl.peekAuthFailureBudget(egress, novel, BUDGET)).allowed,
    false,
    "precondition: the egress stuffing window is spent",
  );
}

async function withClock(run: (clock: { advance(ms: number): void }) => Promise<void>) {
  const realNow = Date.now;
  const windowMs = BUDGET.windowSeconds * 1_000;
  let now = (Math.floor(realNow() / windowMs) + 1) * windowMs + 1_000;
  Date.now = () => now;
  try {
    await run({
      advance(ms) {
        now += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

let egressCounter = 0;
const freshEgress = () => `192.0.2.${(egressCounter++ % 250) + 1}-${crypto.randomUUID()}`;

const mintedKeys = (redis: FakeUpstash) =>
  [...redis.store.keys()].filter((key) => key.startsWith(MINTED_PREFIX));

// ── Attack 1: process death / restart with Redis — the registry, marks and
// shards must be visible to a FRESH isolate (the implementer's cross-isolate
// claim), else a restarted edge re-locks the venue. ─────────────────────────
Deno.test(
  "redis: a session minted before an isolate restart is still vouched, marked and sharded after it",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      await withClock(async (clock) => {
        const before = await isolate();
        const egress = freshEgress();
        const minted = {
          accessToken: `at-${crypto.randomUUID()}`,
          refreshToken: `rt-${crypto.randomUUID()}`,
          expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        };
        await before.noteMintedSession(minted);
        const deadBearer = await before.authCredentialIdentity(`dead-${crypto.randomUUID()}`);
        assertEquals(
          await before.chargeAuthFailure(egress, deadBearer, "liveness", BUDGET),
          "liveness",
        );
        const spentShard = await before.authCredentialIdentity(`spent-${crypto.randomUUID()}`);
        for (let i = 0; i < BUDGET.limit; i += 1) {
          await before.chargeAuthFailure(freshEgress(), spentShard, "liveness", BUDGET);
        }

        // The isolate dies; a fresh one boots against the same Redis.
        clock.advance(1_000);
        const after = await isolate();
        await saturate(after, egress);

        const bearer = await after.authCredentialIdentity(minted.accessToken);
        const refresh = await after.authCredentialIdentity(minted.refreshToken);
        assertEquals(
          (await after.peekAuthFailureBudget(egress, bearer, BUDGET)).allowed,
          true,
          "the minted access token passes the saturated gate on the restarted isolate",
        );
        assertEquals(
          (await after.peekAuthFailureBudget(egress, refresh, BUDGET)).allowed,
          true,
          "the minted refresh token passes the saturated gate on the restarted isolate",
        );
        assertEquals(
          await after.chargeAuthFailure(egress, refresh, "unknown-token", BUDGET),
          "liveness",
          "refresh_token_not_found for a token minted before the restart is a sign-out, not a guess",
        );
        assertEquals(
          (await after.peekAuthFailureBudget(egress, deadBearer, BUDGET)).allowed,
          true,
          "a credential judged dead before the restart is still admitted to Auth",
        );
        assertEquals(
          (await after.peekAuthFailureBudget(freshEgress(), spentShard, BUDGET)).allowed,
          false,
          "a credential whose shard was spent before the restart is still held",
        );
      });
    } finally {
      redis.restore();
    }
  },
);

// ── Attack 2: rotation on a SIBLING isolate — the minting isolate's memory
// mirror still vouches the rotated-away refresh token for 365 days while
// Redis (and the sibling) say the 1 h grace has passed. ─────────────────────
Deno.test(
  "[break] redis: a refresh token rotated away on a sibling isolate is no longer vouched on the minting isolate after the grace",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      await withClock(async (clock) => {
        const minter = await isolate();
        const sibling = await isolate();
        const first = {
          accessToken: `at-${crypto.randomUUID()}`,
          refreshToken: `rt-${crypto.randomUUID()}`,
          expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        };
        await minter.noteMintedSession(first);
        const rotatedAway = await minter.authCredentialIdentity(first.refreshToken);

        // The handset refreshes on the sibling isolate: `first.refreshToken`
        // is spent and keeps only the reuse-interval grace.
        const second = {
          accessToken: `at-${crypto.randomUUID()}`,
          refreshToken: `rt-${crypto.randomUUID()}`,
          expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        };
        await sibling.noteMintedSession(second, first.refreshToken);
        const redisEntry = redis.store.get(`${MINTED_PREFIX}${rotatedAway}`);
        assert(redisEntry && redisEntry.expiresAtMs !== null, "Redis holds the shortened vouch");
        assert(
          redisEntry.expiresAtMs - Date.now() <= ROTATED_GRACE_MS,
          "Redis vouch shortened to the grace",
        );

        clock.advance(ROTATED_GRACE_MS + 60_000);

        const egress = freshEgress();
        assertEquals(
          await sibling.chargeAuthFailure(egress, rotatedAway, "unknown-token", BUDGET),
          "credential",
          "the sibling settles the spent token as a credential failure once the grace is over",
        );
        assertEquals(
          await minter.chargeAuthFailure(egress, rotatedAway, "unknown-token", BUDGET),
          "credential",
          "the minting isolate must agree: the same token, the same clock, the same Redis",
        );
      });
    } finally {
      redis.restore();
    }
  },
);

// ── Attack 3: boundary — a session whose expiresAt is not a finite number.
// A vouch must never outlive the 365-day cap, and no Redis key may be
// written without a TTL. ───────────────────────────────────────────────────
Deno.test(
  "[break] redis: a NaN expiresAt does not vouch the access token forever nor leave a TTL-less key",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      await withClock(async (clock) => {
        const rl = await isolate();
        const accessToken = `at-${crypto.randomUUID()}`;
        await rl.noteMintedSession({
          accessToken,
          refreshToken: `rt-${crypto.randomUUID()}`,
          expiresAt: Number.NaN,
        });
        for (const key of mintedKeys(redis)) {
          const expiresAtMs = redis.store.get(key)!.expiresAtMs;
          assert(
            expiresAtMs !== null && Number.isFinite(expiresAtMs),
            `minted key ${key} was written without a finite TTL (EXPIRE ${String(expiresAtMs)})`,
          );
        }
        clock.advance(366 * DAY_MS);
        const egress = freshEgress();
        await saturate(rl, egress);
        const bearer = await rl.authCredentialIdentity(accessToken);
        assertEquals(
          (await rl.peekAuthFailureBudget(egress, bearer, BUDGET)).allowed,
          false,
          "a token with an unreadable expiry is not vouched a year later",
        );
      });
    } finally {
      redis.restore();
    }
  },
);

// ── Attack 4: network failure — Redis hangs until the client timeout on every
// call. The gate must fail open, nothing may throw, and the pre-Auth gate +
// post-Auth charge must stay bounded (each Redis call burns the full
// 1 200 ms REDIS_TIMEOUT_MS; the flat budget on base spent 2 calls). ───────
Deno.test(
  "redis hang: gate fails open and gate + charge stay within 5 sequential Redis round trips",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const rl = await isolate();
      const egress = freshEgress();
      const identity = await rl.authCredentialIdentity(`hang-${crypto.randomUUID()}`);
      redis.hang = true;
      const gateStarted = performance.now();
      const gate = await rl.peekAuthFailureBudget(egress, identity, BUDGET);
      const gateMs = performance.now() - gateStarted;
      assertEquals(gate.allowed, true, "an unreachable Redis never holds a credential");
      const gateCalls = redis.calls;

      const chargeStarted = performance.now();
      await rl.chargeAuthFailure(egress, identity, "unknown-token", BUDGET);
      const chargeMs = performance.now() - chargeStarted;
      const chargeCalls = redis.calls - gateCalls;
      redis.hang = false;

      console.log(
        `[attack] redis hang: gate ${gateCalls} calls/${Math.round(gateMs)}ms, ` +
          `unknown-token charge ${chargeCalls} calls/${Math.round(chargeMs)}ms`,
      );
      assert(gateCalls <= 2, `gate issued ${gateCalls} Redis calls while hanging (${gateMs}ms)`);
      assert(
        chargeCalls <= 3,
        `charge issued ${chargeCalls} Redis calls while hanging (${chargeMs}ms)`,
      );
      assert(
        gateMs + chargeMs < 6_500,
        `gate+charge took ${gateMs + chargeMs}ms under a Redis hang`,
      );
    } finally {
      redis.restore();
    }
  },
);

// ── Attack 5: Redis answers with HTTP 500 / per-command errors / short
// replies — the budget must fail OPEN for the venue (never hold a credential
// it cannot judge) and must not throw. ─────────────────────────────────────
Deno.test(
  "redis faults (500, command error, truncated reply): nothing throws, nothing is held",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const rl = await isolate();
      const egress = freshEgress();
      const identity = await rl.authCredentialIdentity(`faulty-${crypto.randomUUID()}`);
      const minted = {
        accessToken: `at-${crypto.randomUUID()}`,
        refreshToken: `rt-${crypto.randomUUID()}`,
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      };

      redis.failStatus = 500;
      await rl.noteMintedSession(minted);
      assertEquals(
        await rl.chargeAuthFailure(egress, identity, "credential", BUDGET),
        "credential",
      );
      assertEquals((await rl.peekAuthFailureBudget(egress, identity, BUDGET)).allowed, true);
      redis.failStatus = null;

      redis.commandError = (cmd) => (cmd[0] === "INCR" ? "ERR max requests limit exceeded" : null);
      await rl.noteMintedSession(minted);
      assertEquals(await rl.chargeAuthFailure(egress, identity, "liveness", BUDGET), "liveness");
      assertEquals((await rl.peekAuthFailureBudget(egress, identity, BUDGET)).allowed, true);
      redis.commandError = null;

      redis.truncateRepliesTo = 0;
      await rl.noteMintedSession(minted);
      assertEquals(
        await rl.chargeAuthFailure(egress, identity, "credential", BUDGET),
        "credential",
      );
      assertEquals((await rl.peekAuthFailureBudget(egress, identity, BUDGET)).allowed, true);
      redis.truncateRepliesTo = null;

      // Redis is healthy again: the minted session written under faults is
      // vouched locally (memory mirror) and never held.
      await saturate(rl, egress);
      const bearer = await rl.authCredentialIdentity(minted.accessToken);
      assertEquals((await rl.peekAuthFailureBudget(egress, bearer, BUDGET)).allowed, true);
    } finally {
      redis.restore();
    }
  },
);

// ── Attack 6: corrupt persisted state — garbage under the budget's own keys.
// Counters that cannot be read fall back to memory (fail open); a minted key
// holding garbage vouches nothing (fail closed on authorisation). ───────────
Deno.test(
  "redis corrupt values: garbage shard/egress counters fail open, a garbage minted key vouches nothing",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      await withClock(async () => {
        const rl = await isolate();
        const egress = freshEgress();
        const identity = await rl.authCredentialIdentity(`corrupt-${crypto.randomUUID()}`);
        // Discover the exact keys the candidate uses for this identity/egress.
        await rl.chargeAuthFailure(egress, identity, "credential", BUDGET);
        const shardKey = [...redis.store.keys()].find(
          (k) => k.includes(identity) && k.includes("authshard"),
        );
        const egressKey = [...redis.store.keys()].find(
          (k) => k.includes("authfail") && k.includes(egress),
        );
        assert(
          shardKey && egressKey,
          `expected shard+egress keys, saw ${[...redis.store.keys()].join(",")}`,
        );

        for (const garbage of ["", "abc", "-5", "1e400", "99999999999999999999", "NaN", "[]"]) {
          redis.store.set(shardKey, { value: garbage, expiresAtMs: Date.now() + 60_000 });
          redis.store.set(egressKey, { value: garbage, expiresAtMs: Date.now() + 60_000 });
          const gate = await rl.peekAuthFailureBudget(egress, identity, BUDGET);
          assertEquals(
            gate.allowed,
            true,
            `garbage counter ${JSON.stringify(garbage)} must not hold`,
          );
          assert(
            Number.isSafeInteger(gate.remaining) &&
              gate.remaining >= 0 &&
              gate.remaining <= BUDGET.limit,
            `remaining is a sane integer for ${JSON.stringify(garbage)}, got ${gate.remaining}`,
          );
          assert(
            Number.isInteger(gate.retryAfterSeconds) && gate.retryAfterSeconds >= 1,
            `retryAfterSeconds sane for ${JSON.stringify(garbage)}`,
          );
        }

        const forged = await rl.authCredentialIdentity(`forged-${crypto.randomUUID()}`);
        for (const garbage of ["", "abc", "-1", "0", "NaN", "true"]) {
          redis.store.set(`${MINTED_PREFIX}${forged}`, { value: garbage, expiresAtMs: null });
          assertEquals(
            await rl.chargeAuthFailure(egress, forged, "unknown-token", BUDGET),
            "credential",
            `garbage minted value ${JSON.stringify(garbage)} must not vouch a credential`,
          );
        }
        // A saturated egress + garbage minted key: still held (no fabricated authorisation).
        redis.store.delete(shardKey);
        await saturate(rl, egress);
        redis.store.set(`${MINTED_PREFIX}${forged}`, { value: "abc", expiresAtMs: null });
        const heldShard = await rl.authCredentialIdentity(`held-${crypto.randomUUID()}`);
        redis.store.set(`${MINTED_PREFIX}${heldShard}`, { value: "abc", expiresAtMs: null });
        assertEquals((await rl.peekAuthFailureBudget(egress, heldShard, BUDGET)).allowed, false);
      });
    } finally {
      redis.restore();
    }
  },
);

// ── Attack 7: replay across isolates — sixty parallel replays of one dead
// bearer split over two isolates sharing Redis are bounded by the shard. ───
Deno.test(
  "redis: sixty parallel liveness refusals of one credential across two isolates spend one shared shard, not two",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      await withClock(async () => {
        const a = await isolate();
        const b = await isolate();
        const egress = freshEgress();
        const dead = await a.authCredentialIdentity(`dead-${crypto.randomUUID()}`);
        await Promise.all(
          Array.from({ length: 60 }, (_, i) =>
            (i % 2 === 0 ? a : b).chargeAuthFailure(egress, dead, "liveness", BUDGET),
          ),
        );
        assertEquals((await a.peekAuthFailureBudget(egress, dead, BUDGET)).allowed, false);
        assertEquals((await b.peekAuthFailureBudget(egress, dead, BUDGET)).allowed, false);
        const novel = await a.authCredentialIdentity(`novel-${crypto.randomUUID()}`);
        assertEquals(
          (await b.peekAuthFailureBudget(egress, novel, BUDGET)).allowed,
          true,
          "liveness replays never spend the egress stuffing window",
        );
        const shardKeys = [...redis.store.keys()].filter((k) => k.includes("authshard"));
        assertEquals(shardKeys.length, 1, "one shared shard key for one credential");
        assertEquals(redis.store.get(shardKeys[0])!.value, "60");
      });
    } finally {
      redis.restore();
    }
  },
);

// ── Attack 8: classifier precedence — GoTrue's explicit non-liveness codes
// versus a message that happens to read like a liveness shape. The message
// regexes are consulted whenever the code is not one of the five liveness
// codes, so an explicit `bad_jwt` / `validation_failed` code with a
// liveness-shaped message is settled as liveness. GoTrue only produces such
// bodies after a signature verified (expired real JWT, real ID token with
// an odd audience), so the surviving behaviour is pinned here as observed.
Deno.test(
  "classifier: an explicit bad_jwt code wins over nothing — a liveness-shaped message under a credential code is classed liveness; garbage and empty bodies stay credential",
  async () => {
    const rl = await isolate();
    assertEquals(
      rl.authRefusalKind({
        code: 403,
        error_code: "bad_jwt",
        msg: "invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired",
      }),
      "liveness",
    );
    assertEquals(
      rl.authRefusalKind({
        code: 400,
        error_code: "validation_failed",
        msg: "Unacceptable audience in id_token: [session not found]",
      }),
      "liveness",
    );
    assertEquals(
      rl.authRefusalKind({
        code: 403,
        error_code: "bad_jwt",
        msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
      }),
      "credential",
    );
    for (const garbage of [
      null,
      undefined,
      0,
      "",
      [],
      {},
      { error_code: 42 },
      { msg: 7 },
      "\u0000",
    ]) {
      assertEquals(rl.authRefusalKind(garbage), "credential", JSON.stringify(garbage));
    }
    assertEquals(
      rl.authRefusalKind("Invalid Refresh Token: Refresh Token Not Found"),
      "unknown-token",
    );
  },
);
