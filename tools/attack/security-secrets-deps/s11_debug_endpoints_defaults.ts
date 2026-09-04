// S11 — debug endpoints / insecure defaults probe against the REAL edge fn
// (supabase/functions/api/index.ts) running locally on top of the __wf__
// Supabase stub. No production service is contacted.
//
//   deno run -A tools/attack/security-secrets-deps/s11_debug_endpoints_defaults.ts [ARTIFACT_DIR]
//
// Checks (each HELD/BROKEN):
//   - no unauthenticated 200 on debug-ish paths (/debug, /metrics, /admin,
//     /__stub/*, /.env, /v1/admin, …) — everything non-public is 401;
//   - security headers on 200/401/404 (nosniff, no-store, no x-powered-by);
//   - x-request-id: well-formed client ids echoed, junk/oversized ids replaced;
//   - oversized bodies (Content-Length > 5 MB, and chunked with no length)
//     are refused with 413 BEFORE auth;
//   - authed 404 body never carries an HTML content-type (path is reflected);
//   - per-IP limits key on the LAST x-forwarded-for hop: a spoofed leftmost hop
//     does not open a fresh bucket; cf-connecting-ip is trusted as the edge IP
//     (documents the deployment assumption — a bypass only if the function is
//     reachable without Cloudflare in front, which this harness cannot test).
const ENC = new TextEncoder();
function print(line: string) {
  Deno.stdout.writeSync(ENC.encode(line + "\n"));
}
const REPO = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const FN_DIR = `${REPO}/supabase/functions/api`;
const OUT = Deno.args[0] ?? `${Deno.env.get("HOME")}/attack-artifacts/s11`;
await Deno.mkdir(OUT, { recursive: true });
const STUB_PORT = 54399;
const EDGE_PORT = 8000;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const EDGE = `http://127.0.0.1:${EDGE_PORT}`;

const results: string[] = [];
let held = 0,
  broken = 0;
function check(name: string, ok: boolean, observed: string, expected: string) {
  const line = `${ok ? "HELD  " : "BROKEN"} ${name}: observed=${observed} expected=${expected}`;
  results.push(line);
  print(line);
  if (ok) held++;
  else broken++;
}

function spawn(args: string[], cwd: string, env: Record<string, string>, log: string) {
  const out = Deno.openSync(`${log}.stdout`, { create: true, write: true, truncate: true });
  const err = Deno.openSync(log, { create: true, write: true, truncate: true });
  const child = new Deno.Command("deno", {
    args,
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  child.stdout.pipeTo(out.writable).catch(() => {});
  child.stderr.pipeTo(err.writable).catch(() => {});
  return child;
}
async function waitFor(url: string, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      await r.body?.cancel();
      if (r.status < 500) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
}
async function stop(child: Deno.ChildProcess) {
  try {
    child.kill("SIGTERM");
  } catch {
    /* gone */
  }
  await child.status;
}

function b64url(s: string) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const TOKEN = `${b64url(JSON.stringify({ alg: "RS256", kid: "wf", typ: "JWT" }))}.${b64url(
  JSON.stringify({
    iss: "https://accounts.google.com",
    sub: "user-s11",
    aud: "wf",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
)}.sig`;

// Every request gets its own client IP unless the test pins one: the per-IP
// auth-failure budget (30/300s) would otherwise turn later probes into 429s.
let ipCounter = 0;
function freshIp() {
  ipCounter++;
  return `10.211.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}
async function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: BodyInit,
) {
  const h = { "x-forwarded-for": freshIp(), ...headers };
  const r = await fetch(`${EDGE}${path}`, { method, headers: h, body });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers };
}

const PATH = Deno.env.get("PATH") ?? "";
const HOME = Deno.env.get("HOME") ?? "";
const stub = spawn(
  ["run", "-A", "--quiet", "__wf__/supabase_stub.ts"],
  FN_DIR,
  { PATH, HOME, STUB_PORT: String(STUB_PORT) },
  `${OUT}/stub.log`,
);
let edge: Deno.ChildProcess | null = null;
try {
  await waitFor(`${STUB}/__stub/stats`);
  edge = spawn(
    ["run", "-A", "--node-modules-dir=none", "--quiet", "index.ts"],
    FN_DIR,
    { PATH, HOME, SUPABASE_URL: STUB, SUPABASE_ANON_KEY: "x" },
    `${OUT}/edge.log`,
  );
  await waitFor(`${EDGE}/healthz`);

  // ── debug-ish paths, unauthenticated ──────────────────────────────────────
  const probes = [
    "/debug",
    "/metrics",
    "/admin",
    "/status",
    "/__stub/stats",
    "/__stub/state",
    "/.env",
    "/env",
    "/v1/admin",
    "/v1/debug",
    "/v1/metrics",
    "/v1/config",
    "/v1/me",
    "/v1/progress",
    "/v1/rank",
    "/functions/v1/api/v1/me",
    "/api/v1/me",
    "/v1/../healthz",
    "/v1/%2e%2e/healthz",
    "/graphql",
    "/swagger",
    "/openapi.json",
    "/docs",
    "/v1/internal/flags",
    "/v1/feature-flags",
  ];
  const leaks: string[] = [];
  const table: Record<string, number> = {};
  for (const p of probes) {
    for (const m of ["GET", "POST"]) {
      const r = await req(
        m,
        p,
        m === "POST" ? { "content-type": "application/json" } : {},
        m === "POST" ? "{}" : undefined,
      );
      table[`${m} ${p}`] = r.status;
      if (r.status >= 200 && r.status < 300 && !(m === "GET" && p.endsWith("/healthz")))
        leaks.push(`${m} ${p} → ${r.status}`);
      if (/stack|at .*\.ts:\d+|Deno\.|TypeError|ReferenceError/.test(r.text))
        leaks.push(`${m} ${p} body leaks internals: ${r.text.slice(0, 80)}`);
    }
  }
  await Deno.writeTextFile(`${OUT}/probe-table.json`, JSON.stringify(table, null, 2));
  check(
    "S11a no unauthenticated 2xx / internals on debug-ish paths",
    leaks.length === 0,
    leaks.join("; ") || `${Object.keys(table).length} probes all 401/404/405`,
    "none",
  );
  // Public routes match on the pathname SUFFIX (gateway mount prefix is
  // unknown), so `GET …/healthz` under any prefix is 200 by design.
  const nonPublic = Object.entries(table).filter(
    ([k]) => !(k.startsWith("GET") && k.endsWith("/healthz")),
  );
  const all401 = nonPublic.every(([, v]) => v === 401);
  check(
    "S11a every non-public path is 401 before any routing",
    all401,
    JSON.stringify(Object.fromEntries(nonPublic.filter(([, v]) => v !== 401))),
    "all 401",
  );

  // ── security headers ──────────────────────────────────────────────────────
  const hz = await req("GET", "/healthz");
  const unauth = await req("GET", "/v1/me");
  for (const [label, r] of [
    ["200 /healthz", hz],
    ["401 /v1/me", unauth],
  ] as const) {
    const h = r.headers;
    const ok =
      h.get("x-content-type-options") === "nosniff" &&
      !h.get("x-powered-by") &&
      !h.get("server") &&
      /no-store/.test(h.get("cache-control") ?? "") &&
      !!h.get("x-request-id");
    check(
      `S11b security headers on ${label}`,
      ok,
      `nosniff=${h.get("x-content-type-options")} cache=${h.get("cache-control")} powered-by=${h.get("x-powered-by")} server=${h.get("server")} rid=${!!h.get("x-request-id")}`,
      "nosniff, no-store, no x-powered-by/server, x-request-id present",
    );
  }

  // ── x-request-id echo contract ────────────────────────────────────────────
  const goodId = "attack-s11-" + crypto.randomUUID().slice(0, 8);
  const r1 = await req("GET", "/healthz", { "x-request-id": goodId });
  check(
    "S11c well-formed x-request-id echoed",
    r1.headers.get("x-request-id") === goodId,
    `${r1.headers.get("x-request-id")}`,
    goodId,
  );
  const junk = "<script>alert(1)</script>";
  const r2 = await req("GET", "/healthz", { "x-request-id": junk });
  check(
    "S11c junk x-request-id replaced",
    r2.headers.get("x-request-id") !== junk &&
      /^[0-9a-f-]{36}$/.test(r2.headers.get("x-request-id") ?? ""),
    `${r2.headers.get("x-request-id")}`,
    "fresh uuid",
  );
  const r3 = await req("GET", "/healthz", { "x-request-id": "a".repeat(65) });
  check(
    "S11c 65-char x-request-id replaced",
    r3.headers.get("x-request-id") !== "a".repeat(65),
    `${(r3.headers.get("x-request-id") ?? "").length} chars`,
    "uuid (36)",
  );

  // ── oversized bodies refused pre-auth ─────────────────────────────────────
  const r4 = await req(
    "POST",
    "/v1/me/consent/grant",
    { "content-type": "application/json", "content-length": "6000000" },
    "{}".padEnd(6_000_000, " "),
  );
  check(
    "S11d Content-Length 6 MB → 413 before auth",
    r4.status === 413,
    `${r4.status} ${r4.text.slice(0, 80)}`,
    "413",
  );
  // Chunked: no content-length, ~6 MB streamed, with a VALID bearer so the
  // bounded reader (not the header check) is what refuses it.
  const big = new TextEncoder().encode(`{"consent":"${"x".repeat(6_000_000)}"}`);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < big.length; i += 65536) c.enqueue(big.subarray(i, i + 65536));
      c.close();
    },
  });
  const r5 = await fetch(`${EDGE}/v1/me/consent/grant`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      "x-forwarded-for": freshIp(),
    },
    body: stream,
  });
  const t5 = await r5.text();
  check(
    "S11d chunked 6 MB body (no Content-Length) → 413",
    r5.status === 413,
    `${r5.status} ${t5.slice(0, 80)}`,
    "413",
  );
  const hzAfter = await req("GET", "/healthz");
  check(
    "S11d edge healthy after oversized bodies",
    hzAfter.status === 200,
    `${hzAfter.status}`,
    "200",
  );

  // ── authed 404 reflects the route: must stay JSON ──────────────────────────
  const r6 = await req("GET", "/v1/<img src=x onerror=alert(1)>", {
    Authorization: `Bearer ${TOKEN}`,
  });
  check(
    "S11e authed unknown route → 404 JSON (reflected path never HTML)",
    r6.status === 404 &&
      /^application\/json/.test(r6.headers.get("content-type") ?? "") &&
      r6.headers.get("x-content-type-options") === "nosniff",
    `${r6.status} ct=${r6.headers.get("content-type")} body=${r6.text.slice(0, 100)}`,
    "404 application/json nosniff",
  );

  // ── per-IP limit keys on the LAST x-forwarded-for hop ─────────────────────
  // healthz budget is PUBLIC_PAGE_LIMIT 60/60s per IP. Exhaust for 203.0.113.9.
  const ip = "203.0.113.9";
  let first429 = -1;
  for (let i = 0; i < 70; i++) {
    const r = await req("GET", "/healthz", { "x-forwarded-for": ip });
    if (r.status === 429) {
      first429 = i;
      break;
    }
  }
  check(
    "S11f healthz per-IP budget trips (60/60s)",
    first429 >= 55 && first429 <= 61,
    `first 429 at request #${first429 + 1}`,
    "#61",
  );
  const spoofLeft = await req("GET", "/healthz", { "x-forwarded-for": `198.51.100.77, ${ip}` });
  check(
    "S11f spoofed LEFTMOST x-forwarded-for hop does not reset the bucket",
    spoofLeft.status === 429,
    `${spoofLeft.status}`,
    "429",
  );
  const other = await req("GET", "/healthz", { "x-forwarded-for": "198.51.100.78" });
  check(
    "S11f different last hop → own bucket (200)",
    other.status === 200,
    `${other.status}`,
    "200",
  );
  const cf = await req("GET", "/healthz", {
    "x-forwarded-for": ip,
    "cf-connecting-ip": "198.51.100.79",
  });
  results.push(
    `OBSERVATION S11f cf-connecting-ip is trusted over x-forwarded-for: limited XFF ip + fresh cf-connecting-ip → ${cf.status} (safe only if Cloudflare always overwrites this header in production — UNKNOWN from Linux)`,
  );
  print(results[results.length - 1]);
  const noHeaders = await req("GET", "/healthz");
  results.push(`OBSERVATION S11f no ip headers → bucket "unknown": ${noHeaders.status}`);
} finally {
  if (edge) await stop(edge);
  await stop(stub);
}
const summary = `${held}/${held + broken} HELD; artifacts in ${OUT}`;
results.push(summary);
print(summary);
await Deno.writeTextFile(`${OUT}/results.txt`, results.join("\n") + "\n");
Deno.exit(broken === 0 ? 0 : 1);
