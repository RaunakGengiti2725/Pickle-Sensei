// Adversarial pass 3 — S5: 1 201 requests from ONE client IP inside one 60 s
// bucket. The general pre-auth IP budget is 1 200/60 s (`ip` scope); healthz
// has its own public budget (`healthz` scope, 60/60 s) and must keep answering
// 200 from the same IP while the general budget is exhausted.
//
// Bearers are 1 200 DISTINCT verified Supabase users so the per-user route
// budget (240/60 s) never interferes — only the IP budget is under test.
// Requests are fired in bursts of 100 concurrent (rapid repeats / interleaving)
// with the wall clock frozen so the whole attack lands in one bucket.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack3_ip_budget_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  authFailCount,
  edgeRequest,
  IP_LIMIT,
  loadAttack3,
  readJson,
  supabaseBearer,
  withClock,
} from "./attack3_harness.ts";

const ROUTE = "/v1/attack3/nowhere";

function userIdFor(index: number): string {
  return `cccccccc-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

Deno.test("S5 HELD: 1 201st request from one IP in one bucket → 429, Retry-After ≤ 60, RateLimit-Limit 1200; healthz from that IP stays 200", async () => {
  const attack = await loadAttack3();
  const ip = "203.0.113.77";
  const t0 = Date.now();
  const exp = Math.floor(t0 / 1000) + 3600;

  await withClock(t0, async () => {
    const statuses = new Map<number, number>();
    for (let burst = 0; burst < IP_LIMIT.limit; burst += 100) {
      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          attack.harness.handler(
            edgeRequest("GET", ROUTE, {
              authorization: `Bearer ${
                supabaseBearer(userIdFor(burst + i + 1), { exp })
              }`,
              ip,
            }),
          )),
      );
      for (const response of responses) {
        await response.body?.cancel();
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      }
    }
    assertEquals(
      statuses.get(404),
      IP_LIMIT.limit,
      `first 1 200 all authenticated: ${JSON.stringify([...statuses])}`,
    );
    assertEquals(attack.getUserCalls().length, IP_LIMIT.limit);

    // 1 201st — with a VALID bearer, so the only thing refusing it is the IP budget.
    const over = await attack.harness.handler(
      edgeRequest("GET", ROUTE, {
        authorization: `Bearer ${
          supabaseBearer(userIdFor(IP_LIMIT.limit + 1), { exp })
        }`,
        ip,
      }),
    );
    const overBody = await readJson(over);
    assertEquals(over.status, 429, JSON.stringify(overBody));
    const retryAfter = Number(over.headers.get("Retry-After"));
    assert(
      Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60,
      `Retry-After=${over.headers.get("Retry-After")}`,
    );
    assertEquals(
      over.headers.get("RateLimit-Limit"),
      String(IP_LIMIT.limit),
      "refused by the IP budget, not another scope",
    );
    assertEquals(over.headers.get("RateLimit-Remaining"), "0");
    assertEquals(over.headers.get("Cache-Control"), "no-store");
    assert(over.headers.get("x-request-id"), "429 carries x-request-id");
    assertEquals(
      attack.getUserCalls().length,
      IP_LIMIT.limit,
      "the refused request never reached GoTrue",
    );
    assertEquals(
      await authFailCount(ip),
      0,
      "an IP-budget refusal is not an auth failure",
    );

    // Rapid repeats past the limit stay refused and never touch upstream.
    const more = await Promise.all(
      Array.from(
        { length: 50 },
        () =>
          attack.harness.handler(
            edgeRequest("GET", ROUTE, { authorization: "Bearer", ip }),
          ),
      ),
    );
    for (const response of more) {
      await response.body?.cancel();
      assertEquals(response.status, 429);
    }
    assertEquals(
      await authFailCount(ip),
      0,
      "refused-before-auth requests are not charged as auth failures",
    );

    // Public budgets are separate: healthz / legal pages still answer.
    for (const path of ["/healthz", "/privacy", "/terms", "/support"]) {
      const pub = await attack.harness.handler(
        edgeRequest("GET", path, { ip }),
      );
      await pub.body?.cancel();
      assertEquals(pub.status, 200, `${path} from the throttled IP`);
    }
    const head = await attack.harness.handler(
      edgeRequest("HEAD", "/healthz", { ip }),
    );
    await head.body?.cancel();
    assertEquals(head.status, 200);

    // Anonymous session routes DO share the IP budget (they run after it).
    const refresh = await attack.harness.handler(
      edgeRequest("POST", "/v1/auth/refresh", {
        ip,
        body: JSON.stringify({ refreshToken: "rt" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    await refresh.body?.cancel();
    assertEquals(refresh.status, 429);
    assertEquals(attack.upstreamTo("/auth/v1/token").length, 0);
  });

  // Next bucket: the same IP is served again.
  await withClock(t0 + 61_000, async () => {
    const fresh = await attack.harness.handler(
      edgeRequest("GET", ROUTE, {
        authorization: `Bearer ${supabaseBearer(userIdFor(1), { exp })}`,
        ip,
      }),
    );
    await fresh.body?.cancel();
    assertEquals(fresh.status, 404, "IP budget released after the window");
  });
});

Deno.test("S5 HELD: the healthz public budget (60/60 s) trips on its own — /v1 routes from that IP are unaffected", async () => {
  const attack = await loadAttack3();
  const ip = "203.0.113.78";
  const t0 = Date.now();
  const exp = Math.floor(t0 / 1000) + 3600;
  await withClock(t0, async () => {
    for (let i = 0; i < 60; i++) {
      const ok = await attack.harness.handler(
        edgeRequest("GET", "/healthz", { ip }),
      );
      await ok.body?.cancel();
      assertEquals(ok.status, 200, `healthz #${i + 1}`);
    }
    const over = await attack.harness.handler(
      edgeRequest("GET", "/healthz", { ip }),
    );
    await over.body?.cancel();
    assertEquals(over.status, 429);
    assertEquals(over.headers.get("RateLimit-Limit"), "60");
    assert(Number(over.headers.get("Retry-After")) <= 60);

    // /privacy shares the `legal` scope with /terms and /support, not healthz.
    const privacy = await attack.harness.handler(
      edgeRequest("GET", "/privacy", { ip }),
    );
    await privacy.body?.cancel();
    assertEquals(privacy.status, 200);

    const api = await attack.harness.handler(
      edgeRequest("GET", ROUTE, {
        authorization: `Bearer ${supabaseBearer(userIdFor(9_001), { exp })}`,
        ip,
      }),
    );
    await api.body?.cancel();
    assertEquals(
      api.status,
      404,
      "general IP budget untouched by healthz spam",
    );
  });
});

Deno.test("S5 HELD: X-Forwarded-For spoofing — the budget keys on the LAST hop (appended by the gateway); forged leading hops do not escape it", async () => {
  const attack = await loadAttack3();
  const t0 = Date.now();
  await withClock(t0, async () => {
    // Rotating client-supplied leading hops, same trusted last hop → same bucket.
    for (let i = 0; i < 30; i++) {
      const response = await attack.harness.handler(
        edgeRequest("GET", ROUTE, {
          authorization: "Bearer",
          ip: `10.0.0.${i}, 192.168.${i}.1, 203.0.113.90`,
        }),
      );
      await response.body?.cancel();
      assertEquals(response.status, 401);
    }
    const tripped = await attack.harness.handler(
      edgeRequest("GET", ROUTE, {
        authorization: "Bearer",
        ip: "10.9.9.9, 203.0.113.90",
      }),
    );
    await tripped.body?.cancel();
    assertEquals(
      tripped.status,
      429,
      "auth-failure budget keyed on the last hop",
    );
    assertEquals(tripped.headers.get("RateLimit-Limit"), "30");

    // cf-connecting-ip (set by the edge) wins over any forwarded list.
    const cf = await attack.harness.handler(
      edgeRequest("GET", ROUTE, {
        authorization: "Bearer",
        ip: "10.9.9.9, 203.0.113.90",
        headers: { "cf-connecting-ip": "203.0.113.91" },
      }),
    );
    await cf.body?.cancel();
    assertEquals(
      cf.status,
      401,
      "a different edge-asserted client IP is a fresh bucket",
    );
  });
});

Deno.test("S5 HELD: unicode / oversized / garbage X-Forwarded-For values are bucketed without crashing", async () => {
  const attack = await loadAttack3();
  for (
    const forwarded of [
      "ünïcödé",
      "x".repeat(10_000),
      "",
      ",,,",
      "::ffff:203.0.113.1, evil",
      "203.0.113.1;drop table",
    ]
  ) {
    const response = await attack.harness.handler(
      edgeRequest("GET", "/healthz", { ip: forwarded }),
    );
    await response.body?.cancel();
    assertEquals(response.status, 200, JSON.stringify(forwarded.slice(0, 40)));
  }
});
