// Adversarial scenarios S6 + S8 — RevenueCat webhook of the REAL edge function
// (supabase/functions/api/index.ts) run locally against webhook_stub.ts.
//
//   deno run -A tools/attack/security-secrets-deps/s6_s8_webhook.ts [out-dir]
//
// S8  auth matrix: no REVENUECAT_WEBHOOK_AUTH → 503; wrong Authorization → 401;
//     correct + `{}` → 400 (+ a few unusual variants).
// S6  100 rapid identical event.id → idempotent webhook_events (exactly one
//     row), then WEBHOOK_LIMIT (240/min per IP) → 429 with Retry-After.
//
// Nothing here touches a real Supabase project: SUPABASE_URL points at the
// stub and every secret is a synthetic test string.
// Exit 0 = every expectation HELD, 1 = at least one BROKEN, 2 = harness error.

const ENC = new TextEncoder();
function print(line: string) {
  Deno.stdout.writeSync(ENC.encode(line + "\n"));
}
const here = new URL(".", import.meta.url).pathname;
const repoRoot = new URL("../../../", import.meta.url).pathname;
const apiDir = `${repoRoot}supabase/functions/api`;
const OUT = Deno.args[0] ?? `${repoRoot}artifacts/attack/s6_s8`;
await Deno.mkdir(OUT, { recursive: true });

const STUB_PORT = Number(Deno.env.get("STUB_PORT") ?? "54399");
const EDGE_PORT = 8000; // index.ts calls Deno.serve() without options → 8000
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const EDGE = `http://127.0.0.1:${EDGE_PORT}`;
const WEBHOOK = `${EDGE}/webhooks/revenuecat`;
const SECRET = "attack-harness-webhook-secret-not-real-3f9a";
const SEED = Number(Deno.env.get("SEED") ?? "20260904");

// Tiny seeded PRNG (mulberry32) so event ids are reproducible from SEED.
let seedState = SEED >>> 0;
function rand(): number {
  seedState = (seedState + 0x6d2b79f5) >>> 0;
  let t = seedState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rid = () =>
  Math.floor(rand() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");

type Check = { name: string; held: boolean; observed: string; expected: string };
const checks: Check[] = [];
function check(name: string, held: boolean, observed: string, expected: string) {
  checks.push({ name, held, observed, expected });
  print(`${held ? "HELD  " : "BROKEN"} ${name}: observed=${observed} expected=${expected}`);
}

async function waitFor(url: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      await r.body?.cancel();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`timeout waiting for ${url}`);
}

function spawn(args: string[], cwd: string, env: Record<string, string>, log: string) {
  // Two independent sinks: a WritableStream can only be piped once, and an
  // unconsumed pipe stalls the child on its first large stderr line.
  const out = Deno.openSync(`${log}.stdout`, { create: true, write: true, truncate: true });
  const err = Deno.openSync(log, { create: true, write: true, truncate: true });
  const cmd = new Deno.Command("deno", {
    args,
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  child.stdout.pipeTo(out.writable).catch(() => {});
  child.stderr.pipeTo(err.writable).catch(() => {});
  return child;
}

async function stop(child: Deno.ChildProcess) {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  await child.status;
}

const baseEnv: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "",
  HOME: Deno.env.get("HOME") ?? "",
  DENO_DIR: Deno.env.get("DENO_DIR") ?? "",
  SUPABASE_URL: STUB,
  SUPABASE_ANON_KEY: "x",
};
if (!baseEnv.DENO_DIR) delete baseEnv.DENO_DIR;

async function startEdge(extra: Record<string, string>, log: string) {
  const child = spawn(
    ["run", "-A", "--node-modules-dir=none", "--quiet", "index.ts"],
    apiDir,
    { ...baseEnv, ...extra },
    `${OUT}/${log}`,
  );
  await waitFor(`${EDGE}/healthz`);
  return child;
}

async function post(body: string, headers: Record<string, string> = {}) {
  const r = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text };
}

const stub = spawn(
  ["run", "-A", "--quiet", `${here}webhook_stub.ts`],
  here,
  { ...baseEnv, STUB_PORT: String(STUB_PORT) },
  `${OUT}/stub.log`,
);
await waitFor(`${STUB}/__stub/state`);

try {
  // ── S8a: no REVENUECAT_WEBHOOK_AUTH → 503 ────────────────────────────────
  let edge = await startEdge({}, "edge-no-secret.log");
  try {
    const validEvent = JSON.stringify({ event: { id: `evt-${rid()}`, type: "TEST" } });
    const r = await post(validEvent, { Authorization: SECRET });
    check(
      "S8a no REVENUECAT_WEBHOOK_AUTH configured → 503",
      r.status === 503,
      `${r.status} ${r.text}`,
      "503",
    );
    const r2 = await post(validEvent);
    check(
      "S8a no secret AND no Authorization → still 503 (fail closed, not 401)",
      r2.status === 503,
      String(r2.status),
      "503",
    );
  } finally {
    await stop(edge);
  }

  // ── S8b/c + S6: secret configured ─────────────────────────────────────────
  edge = await startEdge(
    { REVENUECAT_WEBHOOK_AUTH: SECRET, SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-not-real" },
    "edge-with-secret.log",
  );
  try {
    const validEvent = () => JSON.stringify({ event: { id: `evt-${rid()}`, type: "TEST" } });
    let r = await post(validEvent(), { Authorization: "wrong-secret" });
    check("S8b wrong Authorization → 401", r.status === 401, String(r.status), "401");
    r = await post(validEvent(), { Authorization: SECRET.slice(0, -1) + "X" });
    check("S8b same-length wrong Authorization → 401", r.status === 401, String(r.status), "401");
    r = await post(validEvent(), { Authorization: `Bearer ${SECRET}` });
    check("S8b 'Bearer <secret>' (prefixed) → 401", r.status === 401, String(r.status), "401");
    r = await post(validEvent());
    check("S8b missing Authorization → 401", r.status === 401, String(r.status), "401");
    r = await post(validEvent(), { Authorization: SECRET.toUpperCase() });
    check("S8b case-flipped secret → 401", r.status === 401, String(r.status), "401");
    r = await post(validEvent(), { Authorization: "" });
    check("S8b empty Authorization → 401", r.status === 401, String(r.status), "401");

    r = await post("{}", { Authorization: SECRET });
    check("S8c correct secret + `{}` → 400", r.status === 400, `${r.status} ${r.text}`, "400");
    r = await post("not json", { Authorization: SECRET });
    check("S8c correct secret + non-JSON → 400", r.status === 400, String(r.status), "400");
    r = await post(JSON.stringify({ event: "string" }), { Authorization: SECRET });
    check("S8c correct secret + event:string → 400", r.status === 400, String(r.status), "400");
    r = await post("[]", { Authorization: SECRET });
    check("S8c correct secret + JSON array → 400", r.status === 400, String(r.status), "400");

    // Unusual: event.id unicode / huge — must not 5xx.
    r = await post(
      JSON.stringify({ event: { id: "evt-\u2603-\uD83E\uDD52-" + rid(), type: "TEST" } }),
      { Authorization: SECRET },
    );
    check("S8x unicode event.id → 200", r.status === 200, `${r.status} ${r.text}`, "200");
    const hugeId = "e".repeat(200_000);
    let tHuge = performance.now();
    r = await post(JSON.stringify({ event: { id: hugeId, type: "TEST" } }), {
      Authorization: SECRET,
    });
    const hugeMs = Math.round(performance.now() - tHuge);
    check(
      "S8x 200 KB event.id → 2xx, no 5xx",
      r.status >= 200 && r.status < 300,
      `${r.status} in ${hugeMs}ms`,
      "2xx",
    );
    tHuge = performance.now();
    r = await post(JSON.stringify({ event: { id: hugeId, type: "TEST" } }), {
      Authorization: SECRET,
    });
    check(
      "S8x replay of the 200 KB event.id → duplicate:true (dedupe lookup survives a huge id)",
      r.status === 200 && r.text.includes('"duplicate":true'),
      `${r.status} ${r.text} in ${Math.round(performance.now() - tHuge)}ms`,
      "200 duplicate:true",
    );
    r = await post(
      JSON.stringify({ event: { id: `evt-${rid()}`, type: "TEST", app_user_id: "not-a-uuid" } }),
      { Authorization: SECRET },
    );
    check(
      "S8x non-uuid app_user_id → 200 verified:false (no RevenueCat call)",
      r.status === 200 && r.text.includes('"verified":false'),
      `${r.status} ${r.text}`,
      "200 verified:false",
    );

    // ── S6: 100 rapid identical event.id (concurrent) ───────────────────────
    await fetch(`${STUB}/__stub/reset`, { method: "POST" }).then((x) => x.body?.cancel());
    const sameId = `evt-same-${rid()}`;
    const body = JSON.stringify({
      event: { id: sameId, type: "RENEWAL", aliases: ["$RCAnonymousID:abc"] },
    });
    const t0 = performance.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        post(body, { Authorization: SECRET, "x-forwarded-for": "10.9.0.1" }),
      ),
    );
    const ms = Math.round(performance.now() - t0);
    const statuses = new Map<number, number>();
    let dup = 0,
      fresh = 0;
    for (const x of results) {
      statuses.set(x.status, (statuses.get(x.status) ?? 0) + 1);
      if (x.text.includes('"duplicate":true')) dup++;
      else if (x.status === 200) fresh++;
    }
    const state = await (await fetch(`${STUB}/__stub/state`)).json();
    const rowsForId = state.rows.filter((row: { id: string }) => row.id === sameId).length;
    const summary = `statuses=${JSON.stringify([...statuses])} duplicate=${dup} processed=${fresh} rows=${rowsForId} inserted=${state.counters["db:webhook_events inserted"] ?? 0} conflicts=${state.counters["db:webhook_events conflict"] ?? 0} in ${ms}ms`;
    check(
      "S6 100 concurrent identical event.id → all 200, no 5xx",
      [...statuses.keys()].every((s) => s === 200),
      summary,
      "100×200",
    );
    check(
      "S6 100 concurrent identical event.id → exactly one webhook_events row",
      rowsForId === 1,
      `rows=${rowsForId}`,
      "1",
    );
    // Observation only (not a gate): how many of the concurrent 100 were
    // processed before the first audit row landed (the check-then-insert race).
    print(`S6 observation: concurrent race processed=${fresh} short-circuited-as-duplicate=${dup}`);
    Deno.writeTextFileSync(
      `${OUT}/s6-concurrent.json`,
      JSON.stringify(
        {
          seed: SEED,
          sameId,
          ms,
          statuses: [...statuses],
          dup,
          fresh,
          rowsForId,
          counters: state.counters,
        },
        null,
        2,
      ),
    );

    // Sequential replays after the first landed → every one is duplicate:true.
    let seqDup = 0;
    for (let i = 0; i < 100; i++) {
      const x = await post(body, { Authorization: SECRET, "x-forwarded-for": "10.9.0.2" });
      if (x.status === 200 && x.text.includes('"duplicate":true')) seqDup++;
    }
    check(
      "S6 100 sequential replays of a processed event.id → 100× duplicate:true",
      seqDup === 100,
      String(seqDup),
      "100",
    );

    // ── S6: WEBHOOK_LIMIT 240/min per IP → 429 + Retry-After ────────────────
    // Fixed windows align to the clock minute: start early enough in a minute
    // that 245 requests cannot straddle the boundary.
    const sec = new Date().getUTCSeconds();
    if (sec > 40) await new Promise((r) => setTimeout(r, (61 - sec) * 1000));
    const ip = "10.77.0.1";
    const rl: {
      status: number;
      retryAfter: string | null;
      limit: string | null;
      remaining: string | null;
    }[] = [];
    for (let i = 0; i < 245; i++) {
      const x = await post(validEvent(), { Authorization: SECRET, "x-forwarded-for": ip });
      rl.push({
        status: x.status,
        retryAfter: x.headers.get("retry-after"),
        limit: x.headers.get("ratelimit-limit"),
        remaining: x.headers.get("ratelimit-remaining"),
      });
    }
    const first429 = rl.findIndex((x) => x.status === 429);
    const okBefore = rl.slice(0, 240).every((x) => x.status === 200);
    const all429After = rl.slice(240).every((x) => x.status === 429);
    const ra = first429 >= 0 ? Number(rl[first429].retryAfter) : NaN;
    check(
      "S6 WEBHOOK_LIMIT: requests 1..240 → 200",
      okBefore,
      `first non-200 at index ${rl.findIndex((x) => x.status !== 200)}`,
      "none in 1..240",
    );
    check(
      "S6 WEBHOOK_LIMIT: request 241+ → 429",
      first429 === 240 && all429After,
      `first429=${first429} all429After=${all429After}`,
      "241st onwards",
    );
    check(
      "S6 WEBHOOK_LIMIT: 429 carries integer Retry-After 1..60 + RateLimit-Limit 240",
      Number.isInteger(ra) && ra >= 1 && ra <= 60 && rl[first429]?.limit === "240",
      `Retry-After=${rl[first429]?.retryAfter} RateLimit-Limit=${rl[first429]?.limit} Remaining=${rl[first429]?.remaining}`,
      "1..60 / 240",
    );
    Deno.writeTextFileSync(`${OUT}/s6-ratelimit.json`, JSON.stringify(rl, null, 0));

    // Unauthenticated traffic is limited BEFORE the secret check (per IP).
    const x401 = await post(validEvent(), { Authorization: "wrong", "x-forwarded-for": ip });
    check(
      "S6 WEBHOOK_LIMIT applies before auth (limited IP + wrong secret → 429, not 401)",
      x401.status === 429,
      String(x401.status),
      "429",
    );
    // …and another IP is unaffected.
    const other = await post(validEvent(), {
      Authorization: SECRET,
      "x-forwarded-for": "10.77.0.2",
    });
    check(
      "S6 WEBHOOK_LIMIT is per IP (other IP → 200)",
      other.status === 200,
      String(other.status),
      "200",
    );
  } finally {
    await stop(edge);
  }

  // ── S8e: secret set but no service-role key → 503 (fail closed) ─────────
  edge = await startEdge({ REVENUECAT_WEBHOOK_AUTH: SECRET }, "edge-no-service-role.log");
  try {
    const r = await post(JSON.stringify({ event: { id: `evt-${rid()}`, type: "TEST" } }), {
      Authorization: SECRET,
    });
    check(
      "S8e valid event without SUPABASE_SERVICE_ROLE_KEY → 503",
      r.status === 503,
      `${r.status} ${r.text}`,
      "503",
    );
  } finally {
    await stop(edge);
  }
} finally {
  await stop(stub);
}

Deno.writeTextFileSync(`${OUT}/checks.json`, JSON.stringify({ seed: SEED, checks }, null, 2));
const broken = checks.filter((c) => !c.held);
print(
  `\n${checks.length - broken.length}/${checks.length} HELD; seed=${SEED}; artifacts in ${OUT}`,
);
Deno.exit(broken.length ? 1 : 0);
