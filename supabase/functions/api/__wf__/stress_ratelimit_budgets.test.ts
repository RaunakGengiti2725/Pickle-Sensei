// stress-edge-ratelimit — BUDGET campaign against the real handler:
// X-Forwarded-For spoofing, bursts (sequential + concurrent), 429 contract
// (Retry-After / RateLimit-* headers), fixed-window edge, and the fail-open
// behaviour while Upstash flaps.
//
// Seeded (STRESS_SEED): the interleaving of clients inside a burst, the
// spoofed hop values and the flap pattern all come from Prng(seed); every
// scenario writes a seed → outcome JSON row so a run replays exactly.
//
//   cd supabase/functions/api/__wf__ && deno task test --filter stress-budgets
//
// Results: artifacts/stress-edge-ratelimit/budgets/<scenario>.json

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import {
  edgeRequest,
  histogram,
  loadStressHarness,
  registerStressEnvRestore,
  Prng,
  replayCommand,
  type ResponseView,
  sessionToken,
  STRESS_SEED,
  summarize,
  view,
  webhookRequest,
  writeReport,
} from "./stress_ratelimit_harness.ts";

const FILE = "stress_ratelimit_budgets.test.ts";
const PUBLIC_LIMIT = 60; // index.ts PUBLIC_PAGE_LIMIT
const IP_LIMIT = 1_200; // index.ts IP_LIMIT
const REFRESH_LIMIT = 30; // index.ts REFRESH_LIMIT
const WEBHOOK_LIMIT = 240; // index.ts WEBHOOK_LIMIT
const WINDOW_SECONDS = 60;

interface Denied {
  view: ResponseView;
  nosniff: string | null;
  cacheControl: string | null;
  rateLimitLimit: string | null;
  contentType: string | null;
}

async function deniedView(res: Response): Promise<Denied> {
  return {
    nosniff: res.headers.get("X-Content-Type-Options"),
    cacheControl: res.headers.get("Cache-Control"),
    rateLimitLimit: res.headers.get("RateLimit-Limit"),
    contentType: res.headers.get("Content-Type"),
    view: await view(res),
  };
}

function assert429Contract(
  d: Denied,
  limit: number,
  windowSeconds: number,
  label: string,
): string[] {
  const problems: string[] = [];
  if (d.view.status !== 429) problems.push(`${label}: status ${d.view.status}`);
  if (d.view.code !== "rate_limited") problems.push(`${label}: code ${d.view.code}`);
  if (!(d.view.retryAfter !== null && Number.isInteger(d.view.retryAfter)))
    problems.push(`${label}: Retry-After not an integer`);
  else if (d.view.retryAfter < 1 || d.view.retryAfter > windowSeconds)
    problems.push(`${label}: Retry-After ${d.view.retryAfter} outside 1..${windowSeconds}`);
  if (d.view.rateLimitRemaining !== 0)
    problems.push(`${label}: RateLimit-Remaining ${d.view.rateLimitRemaining}`);
  if (d.rateLimitLimit !== String(limit))
    problems.push(`${label}: RateLimit-Limit ${d.rateLimitLimit}`);
  if (d.nosniff !== "nosniff") problems.push(`${label}: X-Content-Type-Options ${d.nosniff}`);
  if (d.cacheControl !== "no-store") problems.push(`${label}: Cache-Control ${d.cacheControl}`);
  if (!d.view.requestId) problems.push(`${label}: missing X-Request-Id`);
  return problems;
}

/** Wall-clock guard: a burst that straddles a fixed-window boundary would
 * legitimately admit 2× — wait for a fresh window when close to the edge. */
async function awayFromWindowEdge(windowSeconds: number, marginMs = 2_500): Promise<void> {
  const now = Date.now();
  const untilEdge = (Math.floor(now / 1000 / windowSeconds) + 1) * windowSeconds * 1000 - now;
  if (untilEdge < marginMs) await new Promise((r) => setTimeout(r, untilEdge + 50));
}

Deno.test(
  "stress-budgets: XFF spoofing — leftmost hops are ignored, rightmost/cf-connecting-ip is the client",
  async () => {
    const h = await loadStressHarness();
    const rng = new Prng(STRESS_SEED).fork("xff");
    await awayFromWindowEdge(WINDOW_SECONDS);
    const scenarios: Array<{
      id: string;
      header: (i: number) => Record<string, string>;
      /** true = every request shares one budget (the (limit+1)th is 429). */
      sharedBucket: boolean;
      note: string;
    }> = [
      {
        id: "rotate-leftmost-fixed-rightmost",
        header: (i) => ({
          "x-forwarded-for": `${rng.ipv4()}, 10.0.${i % 250}.${i % 7}, 198.51.100.200`,
        }),
        sharedBucket: true,
        note: "client-controlled leftmost hops rotate; the peer the proxy appended is constant",
      },
      {
        id: "cf-connecting-ip-wins-over-spoofed-xff",
        header: () => ({
          "cf-connecting-ip": "198.51.100.201",
          "x-forwarded-for": `${rng.ipv4()}, ${rng.ipv4()}`,
        }),
        sharedBucket: true,
        note: "the edge-supplied single IP is authoritative",
      },
      {
        id: "whitespace-variants-same-ip",
        header: (i) => ({
          "x-forwarded-for": [
            " 198.51.100.202",
            "198.51.100.202 ",
            "\t198.51.100.202\t",
            "198.51.100.202",
          ][i % 4],
        }),
        sharedBucket: true,
        note: "hops are trimmed",
      },
      {
        id: "empty-or-garbage-xff-collapses-to-unknown",
        header: (i) => ({ "x-forwarded-for": ["", " , , ", ",", "   "][i % 4] }),
        sharedBucket: true,
        note: "every client without a usable hop shares the single `unknown` budget",
      },
      {
        id: "rotate-rightmost-no-cf-header",
        header: () => ({ "x-forwarded-for": `${rng.ipv4()}, ${rng.ipv4()}.${rng.int(1_000_000)}` }),
        sharedBucket: false,
        note: "harness has NO proxy appending the true peer: a forged trailing hop is a fresh budget here; whether the hosted gateway appends/overwrites XFF (or always sets cf-connecting-ip) is UNKNOWN from Linux",
      },
      {
        id: "octet-variants-not-normalized",
        header: (i) => ({
          "x-forwarded-for": [
            "198.51.100.203",
            "198.051.100.203",
            "0198.51.100.203",
            "198.51.100.203.",
          ][i % 4],
        }),
        sharedBucket: false,
        note: "no canonicalisation of the hop string (only relevant if the trailing hop is client-controlled)",
      },
    ];
    const rows: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    for (const s of scenarios) {
      const statuses: number[] = [];
      let firstDenied: Denied | null = null;
      for (let i = 0; i < PUBLIC_LIMIT + 5; i += 1) {
        const res = await h.handler(
          edgeRequest("GET", "/healthz", { token: null, ip: null, headers: s.header(i) }),
        );
        statuses.push(res.status);
        if (res.status === 429 && !firstDenied) firstDenied = await deniedView(res);
        else await res.body?.cancel();
      }
      const allowed = statuses.filter((st) => st === 200).length;
      const denied = statuses.filter((st) => st === 429).length;
      if (s.sharedBucket) {
        if (allowed !== PUBLIC_LIMIT || denied !== 5)
          failures.push(`${s.id}: allowed ${allowed}, denied ${denied}`);
        if (firstDenied)
          failures.push(...assert429Contract(firstDenied, PUBLIC_LIMIT, WINDOW_SECONDS, s.id));
      } else if (denied !== 0)
        failures.push(`${s.id}: expected distinct budgets, got ${denied} denials`);
      rows.push({
        id: s.id,
        sharedBucket: s.sharedBucket,
        allowed,
        denied,
        firstDenied,
        note: s.note,
      });
    }
    // Very long header: 10 000 hops, still routed to the last one.
    const longHeader =
      Array.from({ length: 10_000 }, () => rng.ipv4()).join(", ") + ", 198.51.100.204";
    const started = performance.now();
    const longRes = await h.handler(
      edgeRequest("GET", "/healthz", {
        token: null,
        ip: null,
        headers: { "x-forwarded-for": longHeader },
      }),
    );
    const longMs = performance.now() - started;
    await longRes.body?.cancel();
    const longKey = [...h.redis.store.keys()].find(
      (k) => k.startsWith("rl:healthz:") && k.endsWith(":198.51.100.204"),
    );
    rows.push({
      id: "xff-10000-hops",
      status: longRes.status,
      ms: Number(longMs.toFixed(2)),
      bucketKeyFound: Boolean(longKey),
    });
    if (longRes.status !== 200 || !longKey)
      failures.push(`xff-10000-hops: status ${longRes.status}, key ${longKey}`);

    const path = await writeReport("budgets", "xff_spoofing", {
      seed: STRESS_SEED,
      replay: replayCommand(FILE, "XFF spoofing"),
      rows,
      failures,
    });
    console.log(`[stress-budgets] XFF → ${path}`);
    assertEquals(failures, []);
  },
);

Deno.test(
  "stress-budgets: interleaved sequential burst — every client gets exactly its budget, then a well-formed 429",
  async () => {
    const h = await loadStressHarness();
    const rng = new Prng(STRESS_SEED).fork("burst-seq");
    await awayFromWindowEdge(WINDOW_SECONDS);
    const clients = Array.from({ length: 8 }, (_, i) => `198.51.100.${210 + i}`);
    const plan: string[] = [];
    for (const ip of clients) for (let i = 0; i < PUBLIC_LIMIT + 10; i += 1) plan.push(ip);
    for (let i = plan.length - 1; i > 0; i -= 1) {
      const j = rng.int(i + 1);
      [plan[i], plan[j]] = [plan[j], plan[i]];
    }
    const perClient: Record<
      string,
      { allowed: number; denied: number; firstDeniedAt: number | null; problems: string[] }
    > = {};
    for (const ip of clients)
      perClient[ip] = { allowed: 0, denied: 0, firstDeniedAt: null, problems: [] };
    const latencies: number[] = [];
    for (let i = 0; i < plan.length; i += 1) {
      const ip = plan[i];
      const t0 = performance.now();
      const res = await h.handler(edgeRequest("GET", "/healthz", { token: null, ip }));
      latencies.push(performance.now() - t0);
      const c = perClient[ip];
      if (res.status === 200) {
        c.allowed += 1;
        if (c.firstDeniedAt !== null) c.problems.push(`allowed again after denial at request ${i}`);
        await res.body?.cancel();
      } else {
        c.denied += 1;
        if (c.firstDeniedAt === null) c.firstDeniedAt = i;
        c.problems.push(
          ...assert429Contract(await deniedView(res), PUBLIC_LIMIT, WINDOW_SECONDS, `${ip}#${i}`),
        );
      }
    }
    const failures: string[] = [];
    for (const [ip, c] of Object.entries(perClient)) {
      if (c.allowed !== PUBLIC_LIMIT) failures.push(`${ip}: allowed ${c.allowed}`);
      if (c.denied !== 10) failures.push(`${ip}: denied ${c.denied}`);
      failures.push(...c.problems.slice(0, 3));
    }
    const path = await writeReport("budgets", "burst_sequential", {
      seed: STRESS_SEED,
      replay: replayCommand(FILE, "interleaved sequential burst"),
      requests: plan.length,
      latencyMs: summarize(latencies),
      perClient,
      failures,
    });
    console.log(`[stress-budgets] sequential burst (${plan.length} req) → ${path}`);
    assertEquals(failures, []);
  },
);

Deno.test(
  "stress-budgets: concurrent burst — Promise.all of 3× the budget admits exactly the budget",
  async () => {
    const h = await loadStressHarness();
    await awayFromWindowEdge(WINDOW_SECONDS);
    const ip = "198.51.100.230";
    const n = PUBLIC_LIMIT * 3;
    const t0 = performance.now();
    const responses = await Promise.all(
      Array.from({ length: n }, () =>
        h.handler(edgeRequest("GET", "/healthz", { token: null, ip })),
      ),
    );
    const wallMs = performance.now() - t0;
    const statuses = responses.map((r) => r.status);
    const denied: Denied[] = [];
    for (const r of responses) {
      if (r.status === 429 && denied.length < 3) denied.push(await deniedView(r));
      else await r.body?.cancel();
    }
    const problems = denied.flatMap((d, i) =>
      assert429Contract(d, PUBLIC_LIMIT, WINDOW_SECONDS, `denied#${i}`),
    );
    const path = await writeReport("budgets", "burst_concurrent", {
      requests: n,
      wallMs: Number(wallMs.toFixed(1)),
      statuses: histogram(statuses),
      problems,
    });
    console.log(`[stress-budgets] concurrent burst → ${path}`);
    assertEquals(histogram(statuses), { "200": PUBLIC_LIMIT, "429": n - PUBLIC_LIMIT });
    assertEquals(problems, []);
  },
);

Deno.test(
  "stress-budgets: per-IP pre-auth budget (1 200/min) with rotating authenticated users",
  async () => {
    const h = await loadStressHarness();
    const rng = new Prng(STRESS_SEED).fork("ip-limit");
    await awayFromWindowEdge(WINDOW_SECONDS, 6_000);
    const ip = "198.51.100.240";
    // 8 users × ≤ 240/min general budget each > 1 200, so the IP budget binds first.
    const tokens = Array.from({ length: 8 }, () => sessionToken({ userId: rng.uuid() }));
    const statuses: number[] = [];
    const latencies: number[] = [];
    let denied: Denied | null = null;
    const t0 = performance.now();
    for (let i = 0; i < IP_LIMIT + 3; i += 1) {
      const s = performance.now();
      const res = await h.handler(
        edgeRequest("GET", "/v1/me/access", { ip, token: tokens[i % tokens.length] }),
      );
      latencies.push(performance.now() - s);
      statuses.push(res.status);
      if (res.status === 429 && !denied) denied = await deniedView(res);
      else await res.body?.cancel();
    }
    const authCalls = h.calls.filter((c) => c.upstream === "auth").length;
    const restCalls = h.calls.filter((c) => c.upstream === "rest").length;
    const path = await writeReport("budgets", "ip_limit_1200", {
      seed: STRESS_SEED,
      replay: replayCommand(FILE, "per-IP pre-auth budget"),
      requests: statuses.length,
      wallMs: Number((performance.now() - t0).toFixed(1)),
      statuses: histogram(statuses),
      firstDeniedIndex: statuses.indexOf(429),
      denied,
      supabaseRoundTrips: {
        auth: authCalls,
        rest: restCalls,
        perAllowedRequest: Number(((authCalls + restCalls) / IP_LIMIT).toFixed(3)),
      },
      latencyMs: summarize(latencies),
    });
    console.log(`[stress-budgets] IP limit → ${path}`);
    assertEquals(histogram(statuses), { "200": IP_LIMIT, "429": 3 });
    assertEquals(statuses.indexOf(429), IP_LIMIT);
    assert(denied !== null);
    assertEquals(assert429Contract(denied, IP_LIMIT, WINDOW_SECONDS, "ip"), []);
    // 8 verifications (one per user, then cached) + one access_state RPC per allowed request.
    assertEquals(authCalls, tokens.length, "auth verified once per user (cached afterwards)");
    assertEquals(restCalls, IP_LIMIT, "exactly one PostgREST round trip per allowed request");
  },
);

Deno.test(
  "stress-budgets: refresh budget — the 31st rotation from one IP is refused before reaching Auth",
  async () => {
    const h = await loadStressHarness();
    await awayFromWindowEdge(WINDOW_SECONDS);
    const ip = "198.51.100.241";
    const statuses: number[] = [];
    for (let i = 0; i < REFRESH_LIMIT; i += 1) {
      const res = await h.handler(
        edgeRequest("POST", "/v1/auth/refresh", {
          ip,
          token: null,
          body: { refreshToken: `refresh-r${i}-u${i}` },
        }),
      );
      statuses.push(res.status);
      await res.body?.cancel();
    }
    const authBefore = h.calls.filter((c) => c.upstream === "auth").length;
    const res = await h.handler(
      edgeRequest("POST", "/v1/auth/refresh", {
        ip,
        token: null,
        body: { refreshToken: "refresh-r31-u31" },
      }),
    );
    const denied = await deniedView(res);
    const authAfter = h.calls.filter((c) => c.upstream === "auth").length;
    const path = await writeReport("budgets", "refresh_limit", {
      statuses: histogram(statuses),
      denied,
      authBefore,
      authAfter,
    });
    console.log(`[stress-budgets] refresh limit → ${path}`);
    assertEquals(histogram(statuses), { "200": REFRESH_LIMIT });
    assertEquals(assert429Contract(denied, REFRESH_LIMIT, WINDOW_SECONDS, "refresh"), []);
    assertEquals(authAfter, authBefore, "the refused refresh reached no upstream");
  },
);

Deno.test(
  "stress-budgets: webhook budget — the 241st delivery from one IP is 429 (RevenueCat retries with backoff)",
  async () => {
    const h = await loadStressHarness();
    await awayFromWindowEdge(WINDOW_SECONDS, 4_000);
    const ip = "198.51.100.242";
    const statuses: number[] = [];
    for (let i = 0; i < WEBHOOK_LIMIT; i += 1) {
      const res = await h.handler(
        webhookRequest(
          {
            id: `evt-wh-${i}`,
            type: "RENEWAL",
            app_user_id: "11111111-1111-4111-8111-111111111111",
          },
          { ip },
        ),
      );
      statuses.push(res.status);
      await res.body?.cancel();
    }
    const rcBefore = h.calls.filter((c) => c.upstream === "rc").length;
    const res = await h.handler(
      webhookRequest(
        { id: "evt-wh-241", type: "RENEWAL", app_user_id: "11111111-1111-4111-8111-111111111111" },
        { ip },
      ),
    );
    const denied = await deniedView(res);
    const rcAfter = h.calls.filter((c) => c.upstream === "rc").length;
    const path = await writeReport("budgets", "webhook_limit", {
      statuses: histogram(statuses),
      denied,
      rcBefore,
      rcAfter,
    });
    console.log(`[stress-budgets] webhook limit → ${path}`);
    assertEquals(histogram(statuses), { "200": WEBHOOK_LIMIT });
    assertEquals(assert429Contract(denied, WEBHOOK_LIMIT, WINDOW_SECONDS, "webhook"), []);
    assertEquals(rcAfter, rcBefore, "the refused delivery re-verified nothing");
  },
);

// ── rateLimit.ts module-level: Retry-After honesty and the fixed-window edge ──

Deno.test(
  "stress-budgets: Retry-After is honest — waiting exactly that long re-admits (1 s windows, memory + Redis)",
  async () => {
    const rng = new Prng(STRESS_SEED).fork("retry-after");
    const rows: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    for (const redisOn of [false, true]) {
      configureRedis(redisOn);
      const redis = fakeUpstash();
      try {
        const iso = await loadIsolate();
        for (let round = 0; round < 6; round += 1) {
          const id = `ra-${redisOn ? "redis" : "mem"}-${rng.int(1e9)}`;
          const limit = 1 + rng.int(3);
          for (let i = 0; i < limit; i += 1)
            await iso.rateLimit.enforceRateLimit("user", id, limit, 1);
          const denied = await iso.rateLimit.enforceRateLimit("user", id, limit, 1);
          const deniedAt = Date.now();
          const expectedRetry = Math.ceil(Math.floor(deniedAt / 1000) + 1 - deniedAt / 1000);
          await new Promise((r) => setTimeout(r, denied.retryAfterSeconds * 1000 + 15));
          const readmitted = await iso.rateLimit.enforceRateLimit("user", id, limit, 1);
          const row = {
            redisOn,
            id,
            limit,
            denied: denied.allowed,
            retryAfter: denied.retryAfterSeconds,
            expectedRetry,
            readmitted: readmitted.allowed,
            readmittedRemaining: readmitted.remaining,
          };
          rows.push(row);
          if (denied.allowed) failures.push(`${id}: not denied at limit`);
          if (denied.retryAfterSeconds < 1 || denied.retryAfterSeconds > 1)
            failures.push(`${id}: Retry-After ${denied.retryAfterSeconds} for a 1 s window`);
          if (!readmitted.allowed || readmitted.remaining !== limit - 1)
            failures.push(`${id}: not re-admitted with a fresh counter after Retry-After`);
        }
      } finally {
        redis.restore();
      }
    }
    const path = await writeReport("budgets", "retry_after_honesty", {
      seed: STRESS_SEED,
      rows,
      failures,
    });
    console.log(`[stress-budgets] Retry-After honesty → ${path}`);
    assertEquals(failures, []);
  },
);

Deno.test(
  "stress-budgets: fixed-window edge — a burst straddling the boundary admits at most 2× the budget",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const limit = 20;
      // Start 150 ms before a 1 s boundary and hammer for 300 ms.
      const now = Date.now();
      const boundary = (Math.floor(now / 1000) + 1) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(0, boundary - now - 150)));
      let allowed = 0;
      let sent = 0;
      const stop = Date.now() + 300;
      while (Date.now() < stop) {
        sent += 1;
        if ((await iso.rateLimit.enforceRateLimit("ip", "edge-burst", limit, 1)).allowed)
          allowed += 1;
      }
      const path = await writeReport("budgets", "fixed_window_edge", {
        limit,
        sent,
        allowed,
        note: "fixed windows admit up to 2× limit across a boundary by design",
      });
      console.log(`[stress-budgets] fixed-window edge → ${path}`);
      assert(allowed <= 2 * limit, `admitted ${allowed} > 2×${limit}`);
      assert(allowed >= limit, `admitted ${allowed} < ${limit}`);
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "stress-budgets: fail-open while Upstash flaps — the effective budget is at most Redis share + memory share",
  async () => {
    // rateLimit.ts falls back to the per-isolate memory window whenever a Redis
    // round trip fails. With Redis answering only part of the time, hits split
    // across two counters, so a client can be admitted up to ~2× the budget on
    // one isolate. Documented design ("never break a request"); measured here.
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const rows: Array<Record<string, unknown>> = [];
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        const rng = new Prng(STRESS_SEED).fork(`flap-${p}`);
        const id = `flap-${p}`;
        const limit = 100;
        let allowed = 0;
        let redisFailures = 0;
        for (let i = 0; i < 3 * limit; i += 1) {
          const fail = rng.chance(p);
          redis.failStatus = fail ? 503 : null;
          if (fail) redisFailures += 1;
          if ((await iso.rateLimit.enforceRateLimit("ip", id, limit, 60)).allowed) allowed += 1;
        }
        redis.failStatus = null;
        rows.push({ p, sent: 3 * limit, redisFailures, allowed, ratioOfBudget: allowed / limit });
        assert(allowed <= 2 * limit, `p=${p}: admitted ${allowed} > 2×${limit}`);
        assert(allowed >= limit, `p=${p}: admitted ${allowed} < ${limit}`);
      }
      const path = await writeReport("budgets", "redis_flap_fail_open", {
        seed: STRESS_SEED,
        rows,
      });
      console.log(`[stress-budgets] Redis flap → ${path}`);
    } finally {
      redis.restore();
    }
  },
);

registerStressEnvRestore(FILE);
