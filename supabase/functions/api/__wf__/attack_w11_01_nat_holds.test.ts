// W11-01 adversarial tests — attacks the candidate WITHSTANDS.
//
// Every test here passes on the candidate (54243f11). The first two are the
// NAT-lockout regression: on BASE (ca928231) thirty liveness 401s behind one
// egress answered 429 to every valid peer, so they FAIL there.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_w11_01_nat_holds.test.ts

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import { userRequest } from "./routesHarness.ts";
import {
  BUDGET,
  forgedBearer,
  frozenClock,
  handsetIdToken,
  pinnedClock,
  wire,
} from "./attack_w11_01_harness.ts";

// ── Regression: liveness 401s behind one NAT ────────────────────────────────

Deno.test(
  "REGRESS liveness/session: thirty signed-out handsets behind one NAT are each 401 once and the venue stays online (peer session 200, fresh sign-in 200, peer refresh 200)",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, bootstrap, probe, refresh } = await wire();
      const ip = "100.64.101.1";
      const peer = await bootstrap(ip);
      assertEquals((await probe(ip, peer.accessToken)).status, 200);

      // Sessions minted earlier (other isolate, days ago) that were since
      // signed out upstream: Auth answers session_not_found.
      const deadHandsets = Array.from({ length: BUDGET.limit }, () => {
        const s = auth.mint();
        auth.signOut(s.access_token, s.refresh_token);
        return s;
      });
      const before = auth.userChecks;
      for (const [i, s] of deadHandsets.entries()) {
        const res = await probe(ip, s.access_token);
        assertEquals(res.status, 401, `dead handset ${i + 1} must hear 401, got ${res.status}`);
      }
      assertEquals(auth.userChecks - before, BUDGET.limit, "each dead session judged once");

      // The venue is still online.
      assertEquals((await probe(ip, peer.accessToken)).status, 200, "peer session");
      const rotated = await refresh(ip, peer.refreshToken, peer.accessToken);
      assertEquals(rotated.status, 200, `peer refresh → ${rotated.status}`);
      const signIn = await bootstrap(ip);
      assertEquals((await probe(ip, signIn.accessToken)).status, 200, "fresh sign-in");
      // A dead handset retrying hears 401 (its sign-out signal), not 429.
      const again = await probe(ip, deadHandsets[0].access_token);
      assertEquals(again.status, 401, "dead handset retry is still 401");
      // A guess from the same egress is still judged by Auth (not deferred).
      const checks = auth.userChecks;
      assertEquals((await probe(ip, forgedBearer())).status, 401);
      assertEquals(auth.userChecks, checks + 1, "the forged bearer was judged upstream");
    } finally {
      restore();
    }
  },
);

Deno.test(
  "REGRESS liveness/refresh: thirty dead refreshes of tokens this edge minted keep a peer's refresh and a never-seen refresh judged by Auth",
  async () => {
    const clock = pinnedClock();
    try {
      const { auth, bootstrap, refresh } = await wire();
      const ip = "100.64.102.1";
      const peer = await bootstrap(ip);
      // Ten handsets sign in here (inside the bootstrap budget), then are
      // signed out upstream; each presents its dead refresh token three times.
      const handsets = [];
      for (let i = 0; i < 10; i += 1) handsets.push(await bootstrap(ip));
      for (const s of handsets) auth.signOut(s.accessToken, s.refreshToken);
      clock.advance(61_000); // past the per-minute refresh budget, inside the window
      let refusals = 0;
      for (let round = 0; round < 3; round += 1) {
        for (const s of handsets) {
          const res = await refresh(ip, s.refreshToken);
          assertEquals(res.status, 401, `dead refresh → ${res.status}`);
          refusals += 1;
        }
        clock.advance(61_000);
      }
      assertEquals(refusals, BUDGET.limit);
      const rotated = await refresh(ip, peer.refreshToken);
      assertEquals(rotated.status, 200, `peer refresh → ${rotated.status}`);
      const grants = auth.tokenGrants;
      const unknown = await refresh(ip, `rt-${crypto.randomUUID()}`);
      assertEquals(unknown.status, 401, "never-seen refresh is judged by Auth");
      assertEquals(auth.tokenGrants, grants + 1);
    } finally {
      clock.restore();
    }
  },
);

// ── Attack: interleaved account switch on one handset ───────────────────────

Deno.test(
  "ATTACK interleaved account switch: A signs out at the edge, B signs in from the same egress; A's stale bearer replayed 40x is 401 locally (one upstream judgement at most) and B stays online",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, bootstrap, probe, refresh, call } = await wire();
      const ip = "100.64.103.1";
      const a = await bootstrap(ip);
      assertEquals((await probe(ip, a.accessToken)).status, 200);
      const logout = await call(
        userRequest("POST", "/v1/auth/logout", { token: a.accessToken, ip, body: {} }),
      );
      assertEquals(logout.status, 204, `logout → ${logout.status}`);
      auth.signOut(a.accessToken, a.refreshToken);

      const b = await bootstrap(ip);
      const checks = auth.userChecks;
      for (let i = 0; i < 40; i += 1) {
        // A's app has not noticed yet and keeps presenting the stale bearer.
        assertEquals((await probe(ip, a.accessToken)).status, 401, `stale A ${i + 1}`);
        assertEquals((await probe(ip, b.accessToken)).status, 200, `B ${i + 1}`);
      }
      assert(
        auth.userChecks - checks <= 2,
        `stale bearer must be answered locally, Auth saw ${auth.userChecks - checks}`,
      );
      const staleRefresh = await refresh(ip, a.refreshToken);
      assertEquals(staleRefresh.status, 401, "A's refresh is refused (sign-out signal)");
      assertEquals((await refresh(ip, b.refreshToken)).status, 200, "B's refresh rotates");
      assertEquals((await probe(ip, forgedBearer())).status, 401, "a guess is still judged");
    } finally {
      restore();
    }
  },
);

// ── Attack: double submit / concurrent first presentation ───────────────────

Deno.test(
  "ATTACK double submit: 20 parallel first presentations of a valid never-seen bearer all succeed; 20 parallel presentations of a dead one are all 401 and move no egress signal",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, probe } = await wire();
      const ip = "100.64.104.1";
      const valid = auth.mint();
      const ok = await Promise.all(Array.from({ length: 20 }, () => probe(ip, valid.access_token)));
      assertEquals(
        ok.map((r) => r.status),
        Array.from({ length: 20 }, () => 200),
      );
      assert(auth.userChecks <= 20);

      const dead = auth.mint();
      auth.signOut(dead.access_token, dead.refresh_token);
      const refused = await Promise.all(
        Array.from({ length: 20 }, () => probe(ip, dead.access_token)),
      );
      assertEquals(
        refused.map((r) => r.status),
        Array.from({ length: 20 }, () => 401),
      );
      // Nothing was charged to the egress: a guess is still judged by Auth.
      const checks = auth.userChecks;
      assertEquals((await probe(ip, forgedBearer())).status, 401);
      assertEquals(auth.userChecks, checks + 1);
    } finally {
      restore();
    }
  },
);

// ── Attack: boundary values on the vouch clock and identities ───────────────

Deno.test(
  "ATTACK boundary values: vouch TTL is clamped for NaN/±Infinity/negative/far-future/far-past/non-number exp; identities trim and are class-scoped",
  async () => {
    configureRedis(false);
    const { rateLimit: rl } = await loadIsolate();
    const day = 24 * 60 * 60;
    const nowSec = Date.now() / 1000;
    for (const exp of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      1e15,
      -1e15,
      nowSec - 10 * 365 * day,
      nowSec + 100 * 365 * day,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ]) {
      const ttl = rl.authVouchTtlSeconds(exp);
      assert(Number.isInteger(ttl), `ttl for ${exp} is ${ttl}`);
      assert(ttl >= 60 && ttl <= 7 * day, `ttl for ${exp} is ${ttl}`);
    }
    for (const exp of [undefined, null, "123", {}, [], true]) {
      assertEquals(rl.authVouchTtlSeconds(exp), 3600, String(exp));
    }
    // A session with a nonsensical expiry is still vouched for at least a minute.
    const ip = "100.64.105.1";
    for (let i = 0; i < BUDGET.limit; i += 1) {
      await rl.chargeAuthFailure(
        ip,
        await rl.authFailureIdentity(`g-${i}`),
        { kind: "credential" },
        BUDGET,
      );
    }
    await rl.vouchAuthSession({ access_token: "odd-a", refresh_token: "odd-r", expires_at: -1 });
    assertEquals(
      (await rl.peekAuthFailureBudget(ip, await rl.authFailureIdentity("odd-a"), BUDGET)).allowed,
      true,
    );
    assertEquals(
      (await rl.peekAuthFailureBudget(ip, await rl.authFailureIdentity("novel"), BUDGET)).allowed,
      false,
    );
    assertEquals(await rl.authFailureIdentity("   "), null);
    assertEquals(await rl.authFailureIdentity(""), null);
    assertEquals(await rl.authFailureIdentity(undefined), null);
    assertEquals(await rl.authFailureIdentity(null), null);
    assertEquals(await rl.authFailureIdentity(" tok "), await rl.authFailureIdentity("tok"));
    assert(
      (await rl.authFailureIdentity("tok", "refresh")) !==
        (await rl.authFailureIdentity("tok", "session")),
    );
    const id = (await rl.authFailureIdentity("tok")) as string;
    assert(!id.includes("tok"), "identity never carries the credential");
  },
);

// ── Attack: clock rollback ──────────────────────────────────────────────────

Deno.test(
  "ATTACK clock rollback: a saturated egress rolled back one window and forward again keeps its verdicts consistent; dead credentials stay 401-locally-answerable; nothing throws",
  async () => {
    const clock = pinnedClock();
    try {
      configureRedis(false);
      const { rateLimit: rl } = await loadIsolate();
      const ip = "100.64.106.1";
      const id = (label: string) => rl.authFailureIdentity(label) as Promise<string>;
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rl.chargeAuthFailure(ip, await id(`g-${i}`), { kind: "credential" }, BUDGET);
      }
      await rl.chargeAuthFailure(ip, await id("dead"), { kind: "liveness" }, BUDGET);
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, false);
      assertEquals(await rl.authCredentialDead("dead"), true);

      const origin = clock.now();
      clock.set(origin - BUDGET.windowSeconds * 1000); // the clock jumps back a window
      const back = await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET);
      assert(back.retryAfterSeconds >= 1 && back.retryAfterSeconds <= BUDGET.windowSeconds);
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rl.chargeAuthFailure(ip, await id(`h-${i}`), { kind: "credential" }, BUDGET);
      }
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, false);
      assertEquals(await rl.authCredentialDead("dead"), true, "dead marker survives rollback");

      clock.set(origin); // and forward again: the original window is still saturated
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, false);
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("dead"), BUDGET)).allowed, true);
      clock.set(origin + BUDGET.windowSeconds * 1000 + 1000);
      assertEquals(
        (await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed,
        true,
        "the next window opens",
      );
    } finally {
      clock.restore();
    }
  },
);

// ── Attack: Redis network failures at each step ─────────────────────────────

Deno.test(
  "ATTACK Redis failure (HTTP 5xx, per-command errors, short replies): shards and signals fall back to memory — thirty guesses still saturate the egress, a vouched peer still passes, a dead credential is still remembered",
  async () => {
    const restore = frozenClock();
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      for (const mode of ["http500", "commandError", "truncated"] as const) {
        redis.failStatus = mode === "http500" ? 500 : null;
        redis.commandError =
          mode === "commandError" ? () => "ERR max requests limit exceeded" : null;
        redis.truncateRepliesTo = mode === "truncated" ? 0 : null;
        const { rateLimit: rl } = await loadIsolate();
        const ip = `100.64.107.${mode.length}`;
        const id = (label: string) => rl.authFailureIdentity(`${mode}-${label}`) as Promise<string>;
        await rl.vouchAuthCredential(`${mode}-peer`, 3600);
        await rl.chargeAuthFailure(ip, await id("dead"), { kind: "liveness" }, BUDGET);
        for (let i = 0; i < BUDGET.limit; i += 1) {
          await rl.chargeAuthFailure(ip, await id(`g-${i}`), { kind: "credential" }, BUDGET);
          const peer = await rl.peekAuthFailureBudget(ip, await id("peer"), BUDGET);
          assertEquals(peer.allowed, true, `${mode}: vouched peer at guess ${i + 1}`);
        }
        assertEquals(
          (await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed,
          false,
          `${mode}: novelty is bounded`,
        );
        assertEquals(
          (await rl.peekAuthFailureBudget(ip, await id("dead"), BUDGET)).allowed,
          true,
          `${mode}: dead credential is let through to its local 401`,
        );
        assertEquals(await rl.authCredentialDead(`${mode}-dead`), true, `${mode}: dead marker`);
        assertEquals(
          (await rl.peekAuthFailureBudget("100.64.107.250", await id("novel"), BUDGET)).allowed,
          true,
          `${mode}: another egress untouched`,
        );
      }
    } finally {
      redis.restore();
      configureRedis(false);
      restore();
    }
  },
);

// ── Attack: corrupt persisted state in Redis ────────────────────────────────

Deno.test(
  "ATTACK corrupt persisted state: garbage / negative / NaN counters in Redis for the egress signal and a shard neither lock the egress nor throw; a marker with an empty value still counts as present",
  async () => {
    const restore = frozenClock();
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const { rateLimit: rl } = await loadIsolate();
      const ip = "100.64.108.1";
      const id = (label: string) => rl.authFailureIdentity(label) as Promise<string>;
      const bucket = Math.floor(Date.now() / (BUDGET.windowSeconds * 1000));
      const novel = await id("novel");
      for (const garbage of ["garbage", "-5", "NaN", "1e400", "", "9007199254740993"]) {
        redis.store.set(`rl:authfail:${bucket}:${ip}`, { value: garbage, expiresAtMs: null });
        redis.store.set(`rl:authcred:${bucket}:${ip}:${novel}`, {
          value: garbage,
          expiresAtMs: null,
        });
        const peek = await rl.peekAuthFailureBudget(ip, novel, BUDGET);
        assertEquals(
          peek.allowed,
          true,
          `corrupt counter ${JSON.stringify(garbage)} must not lock`,
        );
        assert(Number.isFinite(peek.remaining) && peek.remaining >= 0);
        assert(Number.isFinite(peek.retryAfterSeconds) && peek.retryAfterSeconds >= 1);
        await rl.chargeAuthFailure(ip, novel, { kind: "credential" }, BUDGET);
      }
      const vouched = await id("vouched");
      redis.store.set(`rl:authvouch:${vouched}`, { value: "", expiresAtMs: null });
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rl.chargeAuthFailure(ip, await id(`g-${i}`), { kind: "credential" }, BUDGET);
      }
      assertEquals((await rl.peekAuthFailureBudget(ip, vouched, BUDGET)).allowed, true);
    } finally {
      redis.restore();
      configureRedis(false);
      restore();
    }
  },
);

// ── Attack: cross-isolate provenance through Redis ──────────────────────────

Deno.test(
  "ATTACK duplicate identities across isolates (Redis): a refresh token minted on isolate A presented dead on isolate B is liveness, not a guess; a forged one is a guess on both",
  async () => {
    const restore = frozenClock();
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = (await loadIsolate()).rateLimit;
      const b = (await loadIsolate()).rateLimit;
      const ip = "100.64.109.1";
      await a.vouchAuthSession({ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 });
      const minted = (await b.authFailureIdentity("ref-1", "refresh")) as string;
      const forged = (await b.authFailureIdentity("ref-x", "refresh")) as string;
      await b.chargeAuthFailure(ip, null, { kind: "not_found", identity: minted }, BUDGET);
      assertEquals(
        BUDGET.limit - (await b.peekAuthStuffing(ip, BUDGET, "refresh")).remaining,
        0,
        "a minted token gone upstream is liveness on another isolate",
      );
      assertEquals(await b.authCredentialDead("ref-1", "refresh"), true);
      assertEquals(await a.authCredentialDead("ref-1", "refresh"), true, "dead marker is shared");
      await b.chargeAuthFailure(ip, null, { kind: "not_found", identity: forged }, BUDGET);
      assertEquals(BUDGET.limit - (await b.peekAuthStuffing(ip, BUDGET, "refresh")).remaining, 1);
      assertEquals(BUDGET.limit - (await a.peekAuthStuffing(ip, BUDGET, "refresh")).remaining, 1);
      assertEquals(
        BUDGET.limit - (await a.peekAuthStuffing(ip, BUDGET, "session")).remaining,
        0,
        "a refresh flood never fences sessions",
      );
    } finally {
      redis.restore();
      configureRedis(false);
      restore();
    }
  },
);

// ── Attack: replay of one forged bearer from many egresses ──────────────────

Deno.test(
  "ATTACK replay across egresses: one forged bearer replayed from 40 addresses is judged once per address and charges each address one distinct guess — no address is fenced by another's replay",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, probe } = await wire();
      const forged = forgedBearer();
      const before = auth.userChecks;
      for (let i = 0; i < 40; i += 1) {
        assertEquals((await probe(`100.64.110.${i + 1}`, forged)).status, 401);
      }
      assertEquals(auth.userChecks - before, 40);
      for (let i = 0; i < 40; i += 1) {
        assertEquals(
          (await probe(`100.64.110.${i + 1}`, forgedBearer())).status,
          401,
          `address ${i + 1} still judges a novel guess`,
        );
      }
    } finally {
      restore();
    }
  },
);

// ── Attack: kind confusion on the wire ──────────────────────────────────────

Deno.test(
  "ATTACK kind confusion: a session bearer on bootstrap and a refresh token as bearer cost nothing; thirty forged ID tokens saturate only the provider signal — sessions and refreshes on the same egress stay judged and served",
  async () => {
    const clock = pinnedClock();
    try {
      const { auth, bootstrap, probe, refresh, call } = await wire();
      const ip = "100.64.111.1";
      const peer = await bootstrap(ip);
      // Locally refused shapes: cost nothing anywhere.
      for (let i = 0; i < 25; i += 1) {
        const sessionOnBootstrap = await call(
          userRequest("POST", "/v1/account/bootstrap", {
            token: forgedBearer(),
            ip,
            body: {},
          }),
        );
        assertEquals(sessionOnBootstrap.status, 401);
        const refreshAsBearer = await probe(ip, `rt-${crypto.randomUUID()}`);
        assertEquals(refreshAsBearer.status, 401);
      }
      clock.advance(61_000); // past the per-minute bootstrap budget, inside the window
      // Provider guesses on bootstrap saturate ONLY the provider signal.
      const grants = auth.tokenGrants;
      for (let i = 0; i < BUDGET.limit; i += 1) {
        const res = await call(
          userRequest("POST", "/v1/account/bootstrap", {
            token: handsetIdToken(`intruder-${i}`),
            ip,
            body: {},
          }),
        );
        assertEquals(res.status, 401, `forged ID token ${i + 1} → ${res.status}`);
      }
      assertEquals(auth.tokenGrants - grants, BUDGET.limit);
      clock.advance(61_000);
      const deferred = await call(
        userRequest("POST", "/v1/account/bootstrap", {
          token: handsetIdToken("intruder-x"),
          ip,
          body: {},
        }),
      );
      assertEquals(deferred.status, 429, "provider novelty bounded");
      // Sessions and refreshes on the same egress are untouched.
      assertEquals((await probe(ip, peer.accessToken)).status, 200);
      assertEquals((await refresh(ip, peer.refreshToken)).status, 200);
      const checks = auth.userChecks;
      assertEquals((await probe(ip, forgedBearer())).status, 401);
      assertEquals(auth.userChecks, checks + 1, "a session guess is still judged by Auth");
      const unknownRefresh = await refresh(ip, `rt-${crypto.randomUUID()}`);
      assertEquals(unknownRefresh.status, 401, "a refresh guess is still judged by Auth");
    } finally {
      clock.restore();
    }
  },
);
