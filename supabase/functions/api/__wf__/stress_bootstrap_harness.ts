// stress-route-post-v1-account-bootstrap — CONCURRENCY lens.
//
// Shared pieces for the two stress files that drive the REAL edge handler
// (../index.ts, Deno.serve captured by xc_concurrency_harness.ts) at
// POST /v1/account/bootstrap with seeded Promise.all bursts:
//
//   stress_bootstrap_concurrency.test.ts — modelled Supabase (FakeSupabase)
//   stress_bootstrap_pg.test.ts          — REAL postgres:16 behind a tiny
//                                          PostgREST→SQL bridge (XC_PG_URL)
//
// Everything random flows from ONE seed per round (Prng / mulberry32), so a
// failing round replays with the command recorded next to it. Each round's
// outcome is appended to a JSON seed table (writeSeedTable) so the campaign
// output is a seed → HELD/BROKEN map, never a prose claim.
//
// Scale knobs (all optional):
//   STRESS_SEED    master seed            (default 20260905)
//   STRESS_ITER    rounds per scenario    (default 6; campaigns use 40+)
//   STRESS_LANES   concurrent requests per burst (default 16)
//   STRESS_LATENCY max modelled upstream latency ms (default 12)
//   STRESS_ROUND   replay exactly one round index of every scenario
//   STRESS_OUT_DIR where the JSON lands (default artifacts/stress-bootstrap/latest/)

import {
  b64url,
  envInt,
  FakeSupabase,
  isRecord,
  jwtPayload,
  Prng,
  readJson,
  sleep,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

export { b64url, isRecord, jwtPayload, Prng, readJson, sleep };
export type { XcHarness };

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 6);
export const STRESS_LANES = envInt("STRESS_LANES", 16);
export const STRESS_LATENCY = (() => {
  const raw = Deno.env.get("STRESS_LATENCY");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12;
})();
export const STRESS_ROUND = (() => {
  const raw = Deno.env.get("STRESS_ROUND");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
})();
/** Any single burst that takes longer than this is a deadlock/livelock finding. */
export const BURST_DEADLINE_MS = envInt("STRESS_DEADLINE_MS", 20_000);

export const GOOGLE_ISS = "https://accounts.google.com";
export const APPLE_ISS = "https://appleid.apple.com";

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Round seed: master ⊕ scenario ⊕ round, mixed so neighbouring rounds do not
 * share PRNG prefixes. Printed in every seed-table row. */
export function roundSeed(master: number, scenario: string, round: number): number {
  let x = (master ^ fnv1a(scenario)) >>> 0;
  x = (x + Math.imul(round + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** The provider ID token the app forwards. `expOffsetSec` < 0 → already
 * expired (clock skew / stale token). `iatOffsetSec` models a device clock
 * ahead of the server. */
export function providerIdToken(
  provider: "google" | "apple",
  sub: string,
  options: {
    expOffsetSec?: number;
    iatOffsetSec?: number;
    nonce?: string;
    noExp?: boolean;
    email?: string;
  } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: provider === "google" ? GOOGLE_ISS : APPLE_ISS,
    aud: "com.picklesensei",
    sub,
    iat: now + (options.iatOffsetSec ?? 0),
    email: options.email ?? `${sub.slice(0, 8)}@example.com`,
  };
  if (!options.noExp) payload.exp = now + (options.expOffsetSec ?? 3600);
  if (options.nonce) payload.nonce = options.nonce;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "stress" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

export function bootstrapRequest(options: {
  token: string | null;
  ip: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Request {
  const headers = new Headers({ "x-forwarded-for": options.ip, ...options.headers });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const body = options.body === undefined ? "{}" : JSON.stringify(options.body);
  headers.set("Content-Type", "application/json");
  return new Request("http://edge.stress.test/functions/v1/api/v1/account/bootstrap", {
    method: "POST",
    headers,
    body,
    signal: options.signal,
  });
}

export function edgeGet(path: string, token: string, ip: string): Request {
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": ip },
  });
}

export function edgePost(path: string, token: string | null, ip: string, body: unknown): Request {
  const headers = new Headers({ "x-forwarded-for": ip, "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ── Apple server-to-server endpoint (appleid.apple.com/auth/token) ───────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Generate a throwaway P-256 key and export the env the route reads via
 * appleServerConfiguration() (lazily, per request — so setting it after the
 * handler is loaded is fine). Never a real Apple credential. */
export async function installAppleServerEnv(): Promise<void> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const encoded =
    bytesToBase64(pkcs8)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "STRESSTEAM");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "STRESSKEY1");
  Deno.env.set(
    "APPLE_SIGN_IN_PRIVATE_KEY",
    `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
  );
  Deno.env.set(
    "APPLE_TOKEN_ENCRYPTION_KEY",
    bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
  );
}

/** Authorization codes carry their verdict so the fake Apple endpoint is
 * stateless and seed-replayable:
 *   ok:<sub>:<nonce>        → grant bound to <sub>
 *   mismatch:<sub>:<nonce>  → grant bound to a DIFFERENT subject
 *   invalid:<nonce>         → 400 invalid_grant (one-use code replayed)
 *   down:<nonce>            → 503 (Apple unavailable) */
export function appleCode(
  kind: "ok" | "mismatch" | "invalid" | "down",
  sub: string,
  nonce: string,
) {
  return `${kind}:${sub}:${nonce}`;
}

export interface AppleEndpointStats {
  calls: number;
  grants: string[];
}

export function appleTokenResponse(formBody: string, stats: AppleEndpointStats): Response {
  stats.calls += 1;
  const form = new URLSearchParams(formBody);
  const code = form.get("code") ?? "";
  const [kind, sub, nonce] = code.split(":");
  if (kind === "invalid") {
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (kind === "down") {
    return new Response("", { status: 503 });
  }
  const boundSub = kind === "mismatch" ? `other-${sub}` : sub;
  const idToken = `${b64url(JSON.stringify({ alg: "RS256" }))}.${b64url(
    JSON.stringify({ iss: APPLE_ISS, sub: boundSub, aud: "com.picklesensei" }),
  )}.sig`;
  const refreshToken = `apple-rt-${sub}-${nonce}`;
  stats.grants.push(refreshToken);
  return new Response(
    JSON.stringify({
      access_token: "apple-at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      id_token: idToken,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── Seeded scheduler ─────────────────────────────────────────────────────────

/** Start each lane after a seeded jitter so bursts are not lock-step: some
 * lanes overlap fully, some start while others are mid-flight
 * (call-during-call). `spreadMs` 0 = everything at t0. */
export function jittered<T>(
  prng: Prng,
  lanes: number,
  spreadMs: number,
  run: (lane: number, startDelayMs: number) => Promise<T>,
): Promise<T[]> {
  const delays = Array.from({ length: lanes }, () => (spreadMs > 0 ? prng.int(0, spreadMs) : 0));
  return Promise.all(
    delays.map(async (d, lane) => {
      if (d > 0) await sleep(d);
      return run(lane, d);
    }),
  );
}

/** A burst that must finish inside BURST_DEADLINE_MS or it is a deadlock
 * finding (the promise still settles: we never leave a lane dangling). */
export async function withDeadline<T>(
  label: string,
  work: Promise<T>,
): Promise<{ value: T | null; timedOut: boolean; wallMs: number }> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BURST_DEADLINE_MS);
  });
  const outcome = await Promise.race([work.then((v) => ({ v })), timeout]);
  clearTimeout(timer);
  const wallMs = Math.round(performance.now() - t0);
  if (outcome === "timeout") {
    console.error(`[stress] ${label}: burst exceeded ${BURST_DEADLINE_MS}ms`);
    // Let it drain in the background so a hung lane cannot leak into the
    // next round's accounting; the round is already BROKEN.
    work.catch(() => {});
    return { value: null, timedOut: true, wallMs };
  }
  return { value: outcome.v, timedOut: false, wallMs };
}

// ── Rows / invariants / seed table ───────────────────────────────────────────

export interface LaneRow {
  round: number;
  lane: number;
  op: string;
  status: number;
  code?: string;
  userId?: string;
  sessionId?: string;
  startDelayMs?: number;
  startedAt: number;
  endedAt: number;
  note?: string;
}

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export function inv(list: Invariant[], name: string, holds: boolean, detail: string): void {
  list.push({ name, holds, detail });
}

export async function timed(
  rows: LaneRow[],
  round: number,
  lane: number,
  op: string,
  fn: () => Promise<Response>,
  startDelayMs?: number,
): Promise<{ status: number; body: Record<string, unknown>; row: LaneRow }> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fn();
  } catch (error) {
    const row: LaneRow = {
      round,
      lane,
      op,
      status: -1,
      code: "handler_threw",
      startDelayMs,
      startedAt: Math.round(startedAt * 100) / 100,
      endedAt: Math.round(performance.now() * 100) / 100,
      note: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
    rows.push(row);
    return { status: -1, body: {}, row };
  }
  const body = await readJson(response);
  const err = body.error;
  const nested = isRecord(err) ? err.code : undefined;
  const code =
    typeof nested === "string" ? nested : typeof body.code === "string" ? body.code : undefined;
  const user = isRecord(body.user) ? body.user : null;
  const session = isRecord(body.session) ? body.session : null;
  const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
  const sessionId = accessToken ? String(jwtPayload(accessToken)?.session_id ?? "") : undefined;
  const row: LaneRow = {
    round,
    lane,
    op,
    status: response.status,
    code,
    userId: typeof user?.id === "string" ? user.id : undefined,
    sessionId,
    startDelayMs,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
  };
  rows.push(row);
  return { status: response.status, body, row };
}

export const sessionOf = (body: Record<string, unknown>) => {
  const s = isRecord(body.session) ? body.session : {};
  return {
    accessToken: String(s.accessToken ?? ""),
    refreshToken: String(s.refreshToken ?? ""),
    sessionId: String(jwtPayload(String(s.accessToken ?? ""))?.session_id ?? ""),
  };
};

export const histogram = (values: Array<string | number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
};

export interface RoundReport {
  file: string;
  scenario: string;
  round: number;
  seed: number;
  lanes: number;
  /** requests actually issued to the handler in this round */
  requests: number;
  outcome: "HELD" | "BROKEN";
  failed: string[];
  wallMs: number;
  timedOut: boolean;
  statusHistogram: Record<string, number>;
  counters: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  rows: LaneRow[];
  replay: string;
}

export function stressOutDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-bootstrap/latest/", import.meta.url).pathname;
}

/** Scenario ids are `B2-call-during-call`; the Deno.test names carry the same
 * id as `stress B2 call-during-call — …`, which is what `--filter` matches. */
export function testNameFilter(scenario: string): string {
  return `stress ${scenario.replace("-", " ")} `;
}

export function replayCommand(file: string, scenario: string, round: number): string {
  return (
    `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_LANES=${STRESS_LANES} ` +
    `STRESS_LATENCY=${STRESS_LATENCY} STRESS_ROUND=${round} ` +
    `deno test -A --no-check --config deno.json ${file} --filter "${testNameFilter(scenario)}"`
  );
}

/** One JSON per scenario (all rounds) plus a flat seeds table across the file
 * (append-merge so scenarios written by separate Deno.test blocks land in the
 * same table). */
export async function writeRounds(
  file: string,
  scenario: string,
  rounds: RoundReport[],
): Promise<string> {
  const dir = stressOutDir();
  await Deno.mkdir(dir, { recursive: true });
  const tag = file.replace(/\.test\.ts$/, "");
  const path = `${dir}${tag}.${scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(rounds, null, 2));
  const tablePath = `${dir}${tag}.seeds.json`;
  let table: Array<Record<string, unknown>> = [];
  try {
    const existing = JSON.parse(await Deno.readTextFile(tablePath)) as unknown;
    if (Array.isArray(existing)) table = existing as Array<Record<string, unknown>>;
  } catch {
    table = [];
  }
  table = table.filter((row) => row.scenario !== scenario);
  for (const r of rounds) {
    table.push({
      file: r.file,
      scenario: r.scenario,
      round: r.round,
      seed: r.seed,
      lanes: r.lanes,
      requests: r.requests,
      outcome: r.outcome,
      failed: r.failed,
      wallMs: r.wallMs,
      timedOut: r.timedOut,
      statusHistogram: r.statusHistogram,
      replay: r.replay,
    });
  }
  table.sort(
    (a, b) =>
      String(a.scenario).localeCompare(String(b.scenario)) || Number(a.round) - Number(b.round),
  );
  await Deno.writeTextFile(tablePath, JSON.stringify(table, null, 2));
  return path;
}

export function roundsToRun(): number[] {
  if (STRESS_ROUND !== null) return [STRESS_ROUND];
  return Array.from({ length: STRESS_ITER }, (_, i) => i);
}

/** Fake-Supabase reset for a round. The edge fn's per-isolate state
 * (auth cache, rate-limit windows, revocation fences) outlives this reset,
 * so every scenario derives its users/IPs from its own seed — nothing
 * shares a rate-limit key by accident. */
export function resetFake(fake: FakeSupabase, seed: number): void {
  fake.reset(seed, STRESS_LATENCY);
}

export function summarize(
  file: string,
  scenario: string,
  round: number,
  seed: number,
  lanes: number,
  rows: LaneRow[],
  invariants: Invariant[],
  observations: Record<string, unknown>,
  counters: Record<string, number>,
  wallMs: number,
  timedOut: boolean,
): RoundReport {
  const failed = invariants.filter((i) => !i.holds).map((i) => i.name);
  if (timedOut) failed.push("bounded-wall-time");
  return {
    file,
    scenario,
    round,
    seed,
    lanes,
    requests: rows.length,
    outcome: failed.length === 0 ? "HELD" : "BROKEN",
    failed,
    wallMs,
    timedOut,
    statusHistogram: histogram(rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`)),
    counters,
    invariants,
    observations,
    rows,
    replay: replayCommand(file, scenario, round),
  };
}

export function printRound(r: RoundReport): void {
  console.log(
    `[stress] ${r.scenario} round=${r.round} seed=${r.seed} ${r.outcome} ${r.wallMs}ms ` +
      `${JSON.stringify(r.statusHistogram)}`,
  );
  for (const i of r.invariants) {
    if (!i.holds) console.log(`[stress]   BROKEN ${i.name} — ${i.detail}`);
  }
}
