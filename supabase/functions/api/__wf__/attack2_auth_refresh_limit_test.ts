// ADVERSARIAL PASS 3 — edge-auth-cache-ratelimit (#2).
//
// The per-IP `auth_refresh` budget (30 / 60 s) against the REAL handler.
// routesHarness strips the Upstash env, so the limiter runs on the per-isolate
// memory windows of ../rateLimit.ts — the same module instance imported here.
//
//   S2  30 refreshes from one NAT IP succeed; the 31st is 429 with Retry-After;
//       the 429 itself is NOT charged to `authfail`; another caller behind
//       the same NAT can still authenticate (only refresh is throttled).
//   S4  With that IP at its refresh limit, 20 000 distinct-IP requests (each
//       creating a fresh `ip:` window) must NOT unblock it. Inverse of the
//       `[defect]` characterization in rateLimit.test.ts — memory pressure
//       must fail CLOSED for clients already over budget.
//   S9  (own) A blank / absent client address collapses to the shared
//       "unknown" bucket — pinned so the behaviour is explicit.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack2_auth_refresh_limit_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { peekRateLimit } from "../rateLimit.ts";
import { captureAccessLog } from "../http.ts";
import { TEST_USER_ID, fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const AUTH_REFRESH_LIMIT = { limit: 30, windowSeconds: 60 }; // index.ts:2701
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 }; // index.ts:2700
const MEMORY_WINDOW_MAX = 20_000; // rateLimit.ts:23
const PEEK_WIDE = 1_000;

const h = await loadHarness();

function pinClock(): () => void {
  const realNow = Date.now;
  const pinned = Math.floor(realNow() / 300_000) * 300_000 + 10_000;
  Date.now = () => pinned;
  return () => {
    Date.now = realNow;
  };
}

async function count(scope: string, id: string, windowSeconds: number): Promise<number> {
  const peek = await peekRateLimit(scope, id, PEEK_WIDE, windowSeconds);
  return PEEK_WIDE - peek.remaining;
}

function refresh(ip: string, headers?: Record<string, string>): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/auth/refresh", {
      ip,
      token: "unused",
      body: { refreshToken: "refresh-token-under-test" },
      headers,
    }),
  );
}

async function drain(res: Response): Promise<Response> {
  await res.body?.cancel();
  return res;
}

const NAT_IP = "198.51.100.72";

Deno.test(
  "[S2] auth_refresh: 30 refreshes from one NAT IP pass, the 31st is 429 + Retry-After, and the 429 does not charge authfail",
  async () => {
    const unpin = pinClock();
    const restoreLog = captureAccessLog(() => undefined);
    try {
      h.reset();
      h.tables.profiles = [
        {
          id: TEST_USER_ID,
          email: "nat@example.com",
          provider: "google",
          onboarding_state: "complete",
        },
      ];
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_REFRESH_LIMIT.limit; i += 1) {
        statuses.push((await drain(await refresh(NAT_IP))).status);
      }
      const blocked = await refresh(NAT_IP);
      const blockedBody = await blocked.text();
      const retryAfter = blocked.headers.get("Retry-After");
      const refreshCount = await count("auth_refresh", NAT_IP, AUTH_REFRESH_LIMIT.windowSeconds);
      const authfail = await count("authfail", NAT_IP, AUTH_FAILURE_LIMIT.windowSeconds);
      // A different user behind the same NAT authenticates normally (only the
      // refresh route is budgeted), and repeated 429s still do not touch authfail.
      const neighbour = await drain(
        await h.handler(userRequest("GET", "/v1/me", { ip: NAT_IP, token: fakeGoogleIdToken() })),
      );
      for (let i = 0; i < 5; i += 1) await drain(await refresh(NAT_IP));
      const authfailAfterRepeats = await count(
        "authfail",
        NAT_IP,
        AUTH_FAILURE_LIMIT.windowSeconds,
      );

      console.warn(
        `[S2] observed: first30=${[...new Set(statuses)]} 31st=${blocked.status} retry-after=${retryAfter} ` +
          `RateLimit-Limit=${blocked.headers.get("RateLimit-Limit")} RateLimit-Remaining=${blocked.headers.get("RateLimit-Remaining")} ` +
          `auth_refresh(ip)=${refreshCount} authfail(ip)=${authfail} neighbour /v1/me=${neighbour.status} authfail after 5 more 429s=${authfailAfterRepeats} body=${blockedBody.slice(0, 120)}`,
      );

      assert(
        statuses.every((s) => s === 200),
        `first 30 refreshes should succeed, got ${statuses}`,
      );
      assertEquals(blocked.status, 429);
      const retrySeconds = Number(retryAfter);
      assert(
        Number.isInteger(retrySeconds) &&
          retrySeconds >= 1 &&
          retrySeconds <= AUTH_REFRESH_LIMIT.windowSeconds,
        `Retry-After must be an integer within the window, got ${retryAfter}`,
      );
      assertEquals(blocked.headers.get("RateLimit-Limit"), String(AUTH_REFRESH_LIMIT.limit));
      assertEquals(blocked.headers.get("RateLimit-Remaining"), "0");
      assertEquals(JSON.parse(blockedBody).error.code, "rate_limited");
      assertEquals(authfail, 0, "a refresh 429 is not an authentication failure");
      assertEquals(authfailAfterRepeats, 0);
      assertEquals(neighbour.status, 200);
    } finally {
      restoreLog();
      unpin();
    }
  },
);

Deno.test(
  "[S4] 20 000 distinct ip windows do not unblock a client already at its auth_refresh limit",
  async () => {
    const unpin = pinClock();
    const restoreLog = captureAccessLog(() => undefined);
    try {
      h.reset();
      // Ensure the victim is saturated regardless of test ordering.
      let saturated = false;
      for (let i = 0; i <= AUTH_REFRESH_LIMIT.limit; i += 1) {
        const res = await drain(await refresh(NAT_IP));
        if (res.status === 429) {
          saturated = true;
          break;
        }
      }
      assert(saturated, "precondition: victim IP must be over its auth_refresh budget");
      const before = await count("auth_refresh", NAT_IP, AUTH_REFRESH_LIMIT.windowSeconds);

      // Attacker (or simply a busy day): distinct source addresses, each
      // opening a fresh `rl:ip:*` window in the memory fallback.
      const seed = 20_260_904;
      let x = seed;
      const nextIp = (): string => {
        x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
        return `10.${(x >>> 16) & 255}.${(x >>> 8) & 255}.${x & 255}`;
      };
      const seen = new Set<string>();
      const floodStatuses = new Map<number, number>();
      const t0 = performance.now();
      while (seen.size < MEMORY_WINDOW_MAX) {
        const ip = nextIp();
        if (seen.has(ip)) continue;
        seen.add(ip);
        const res = await drain(await h.handler(userRequest("GET", "/healthz", { ip })));
        floodStatuses.set(res.status, (floodStatuses.get(res.status) ?? 0) + 1);
      }
      const floodMs = Math.round(performance.now() - t0);

      const after = await count("auth_refresh", NAT_IP, AUTH_REFRESH_LIMIT.windowSeconds);
      const victim = await drain(await refresh(NAT_IP));
      console.warn(
        `[S4] seed=${seed} observed: victim auth_refresh count before=${before} after flood=${after} ` +
          `flood=${seen.size} ips in ${floodMs}ms statuses=${JSON.stringify([...floodStatuses])} victim refresh after flood=${victim.status}`,
      );
      assertEquals(
        victim.status,
        429,
        `memory pressure from ${seen.size} unrelated windows unblocked a client that was over budget (count ${before} → ${after})`,
      );
      assert(after >= AUTH_REFRESH_LIMIT.limit, `victim count collapsed ${before} → ${after}`);
    } finally {
      restoreLog();
      unpin();
    }
  },
);

Deno.test(
  "[S9] blank x-forwarded-for collapses to the shared 'unknown' bucket (documenting the fail-closed side effect)",
  async () => {
    const unpin = pinClock();
    const restoreLog = captureAccessLog(() => undefined);
    try {
      h.reset();
      const before = await count("auth_refresh", "unknown", AUTH_REFRESH_LIMIT.windowSeconds);
      const blank = await drain(await refresh("   "));
      const huge = await drain(await refresh(" , , ,".repeat(2_000)));
      const after = await count("auth_refresh", "unknown", AUTH_REFRESH_LIMIT.windowSeconds);
      console.warn(
        `[S9] observed: blank-xff refresh=${blank.status} huge-blank-xff refresh=${huge.status} unknown-bucket delta=${after - before}`,
      );
      // Both malformed addresses are charged to ONE shared bucket, so the
      // budget still applies (fails closed) rather than being bypassed.
      assertEquals(after - before, 2);
      assert(blank.status !== 500 && huge.status !== 500);
    } finally {
      restoreLog();
      unpin();
    }
  },
);
