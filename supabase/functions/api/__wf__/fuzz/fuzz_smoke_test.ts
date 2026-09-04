// Deterministic slice of the edge-input fuzz campaign, runnable under
// `deno task test`. Every request stays in-process (routesHarness +
// fuzz/upstream.ts); nothing here talks to a hosted Supabase project.
//
// Full campaign / replay: see fuzz/run.ts.

import { assertEquals } from "@std/assert";
import { loadHarness } from "../routesHarness.ts";
import {
  buildCase,
  createRunner,
  type FailureRecord,
  makeUsers,
  sessionJwt,
  STRATEGIES,
} from "./campaign.ts";
import { Prng } from "./prng.ts";
import { ROUTES } from "./routes.ts";
import { installFuzzUpstream } from "./upstream.ts";

const SEED = "fuzz-smoke-v1";
const COUNT = 600;

// Contract failures the campaign asserts; the second group needs the fixes
// documented in the fuzz report and is asserted separately so the hard
// invariants stay individually visible.
const HARD_INVARIANTS = [
  "server_error_5xx",
  "internal_detail_leak",
  "handler_threw",
  "handler_timeout",
  "prototype_polluted",
  "missing_request_id",
  "request_id_not_sanitized",
  "request_id_reflected_unsanitized",
  "invalid_json_response",
  "429_without_retry_after",
  "accepted_invalid_entries",
  "write_despite_429",
  "write_outside_contract",
  "access_log_missing",
  "access_log_status_mismatch",
  "access_log_request_id_mismatch",
] as const;

interface Campaign {
  failures: FailureRecord[];
  statuses: Map<number | null, number>;
  routes: Set<string>;
  strategies: Set<string>;
}

let cached: Promise<Campaign> | null = null;

function campaign(): Promise<Campaign> {
  cached ??= (async () => {
    const harness = await loadHarness();
    const upstream = installFuzzUpstream(harness);
    const epochSeconds = Math.floor(Date.now() / 1000);
    const runner = createRunner(harness, upstream, { epochSeconds, timeoutMs: 20_000 });
    const users = makeUsers(SEED, 64);
    const out: Campaign = {
      failures: [],
      statuses: new Map(),
      routes: new Set(),
      strategies: new Set(),
    };
    try {
      for (let index = 0; index < COUNT; index += 1) {
        const spec = buildCase(SEED, index, { users, epochSeconds });
        const { result, failure } = await runner.run(spec);
        out.statuses.set(result.status, (out.statuses.get(result.status) ?? 0) + 1);
        out.routes.add(result.routeId);
        out.strategies.add(result.strategy);
        if (failure) out.failures.push(failure);
      }
    } finally {
      runner.dispose();
      upstream.uninstall();
    }
    return out;
  })();
  return cached;
}

const describe = (failures: FailureRecord[]): string =>
  failures
    .map(
      (f) =>
        `${f.result.label} ${f.result.strategy} ${f.result.method} ${f.result.routeId} → ` +
        `${f.result.status} [${f.result.failures.join(", ")}] :: ${f.replay}`,
    )
    .join("\n");

Deno.test("fuzz prng is deterministic and replayable", () => {
  const a = new Prng("fuzz-edge:seed:1");
  const b = new Prng("fuzz-edge:seed:1");
  const c = new Prng("fuzz-edge:seed:2");
  const seqA = Array.from({ length: 16 }, () => a.nextU32());
  const seqB = Array.from({ length: 16 }, () => b.nextU32());
  const seqC = Array.from({ length: 16 }, () => c.nextU32());
  assertEquals(seqA, seqB);
  assertEquals(
    seqA.some((v, i) => v !== seqC[i]),
    true,
  );
});

Deno.test("fuzz cases are byte-identical across builds of the same seed", () => {
  const users = makeUsers(SEED, 8);
  const pool = { users, epochSeconds: 1_800_000_000 };
  for (let index = 0; index < 50; index += 1) {
    const first = buildCase(SEED, index, pool);
    const second = buildCase(SEED, index, pool);
    assertEquals(second.url, first.url);
    assertEquals(second.headers, first.headers);
    assertEquals(second.strategy, first.strategy);
    assertEquals(second.body, first.body);
  }
});

Deno.test("fuzz smoke covers every route and strategy", async () => {
  const run = await campaign();
  const missingRoutes = ROUTES.map((r) => r.id).filter((id) => !run.routes.has(id));
  const missingStrategies = STRATEGIES.filter((s) => !run.strategies.has(s));
  assertEquals(missingRoutes, []);
  assertEquals(missingStrategies, []);
});

Deno.test("fuzz smoke: no 5xx, stack, leak, pollution or write outside contract", async () => {
  const run = await campaign();
  const hard = run.failures.filter((f) =>
    f.result.failures.some((kind) =>
      HARD_INVARIANTS.some((h) => kind === h || kind.startsWith(`${h}:`)),
    ),
  );
  assertEquals(hard.length, 0, `hard invariant violations:\n${describe(hard)}`);
});

// Minimal replays of the two campaign findings (see the fuzz report). They
// pin the exact inputs so a fix can be verified without the full run.

async function minimal(): Promise<{
  handler: (request: Request) => Promise<Response>;
  drainWrites: () => string[];
  bearer: string;
  done: () => void;
}> {
  const harness = await loadHarness();
  const upstream = installFuzzUpstream(harness);
  const users = makeUsers("fuzz-minimal", 32);
  // A subject whose fixture consent ledger has evaluation_telemetry active.
  const user = users.find((u) => /[02468ace]$/i.test(u.id.replace(/-/g, "")))!;
  return {
    handler: harness.handler,
    drainWrites: () =>
      upstream
        .drain()
        .filter((c) => c.kind === "db_write" || c.kind === "rpc_write")
        .map((c) => `${c.method} ${c.target}`),
    bearer: `Bearer ${sessionJwt(user, Math.floor(Date.now() / 1000))}`,
    done: () => upstream.uninstall(),
  };
}

Deno.test("evaluation trials: a deeply nested trialId is rejected, not a 500", async () => {
  const m = await minimal();
  try {
    const depth = 5_000;
    const body = `{"trials":[{"trialId":${"[".repeat(depth)}${"]".repeat(depth)}}]}`;
    const response = await m.handler(
      new Request("https://edge.fuzz.test/functions/v1/api/v1/me/evaluation/trials", {
        method: "POST",
        headers: {
          authorization: m.bearer,
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.77",
        },
        body,
      }),
    );
    await response.text();
    assertEquals(response.status < 500, true, `status ${response.status}`);
    assertEquals(m.drainWrites(), []);
  } finally {
    m.done();
  }
});

Deno.test("saved drills: DELETE with a malformed slug never reaches the database", async () => {
  const m = await minimal();
  try {
    for (const slug of [
      "__proto__",
      "%7B%7D",
      "..%2F..%2Fetc%2Fpasswd",
      "%F0%9F%87%BA%F0%9F%87%B8",
      "a".repeat(2_000),
    ]) {
      const response = await m.handler(
        new Request(`https://edge.fuzz.test/functions/v1/api/v1/me/saved-drills/${slug}`, {
          method: "DELETE",
          headers: { authorization: m.bearer, "x-forwarded-for": "203.0.113.78" },
        }),
      );
      await response.text();
      const writes = m.drainWrites();
      assertEquals(
        writes,
        [],
        `slug ${JSON.stringify(slug.slice(0, 40))} → ${response.status} with writes ${writes.join(", ")}`,
      );
      assertEquals(
        [400, 404].includes(response.status),
        true,
        `slug ${slug.slice(0, 40)} → ${response.status}`,
      );
    }
  } finally {
    m.done();
  }
});

Deno.test(
  "fuzz smoke: adversarial input only yields 400/401/404/413/429 and never a write",
  async () => {
    const run = await campaign();
    const contract = run.failures.filter((f) =>
      f.result.failures.some(
        (kind) =>
          kind.startsWith("status_not_allowed:") || kind.startsWith("write_on_invalid_input"),
      ),
    );
    assertEquals(contract.length, 0, `contract violations:\n${describe(contract)}`);
  },
);
