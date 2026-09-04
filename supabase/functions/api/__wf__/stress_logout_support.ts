// Shared plumbing for the POST /v1/auth/logout concurrency stress campaigns
// (stress_route_post_v1_auth_logout_concurrency*.test.ts).
//
// A campaign is a list of SCENARIOS; each scenario runs STRESS_ITER seeded
// ROUNDS; each round is one Promise.all interleaving of lanes (requests)
// whose start offsets, burst sizes and upstream latencies are all drawn from
// the round's seed. Every round appends one row (seed → outcome) to a JSON
// table under STRESS_OUT_DIR, together with the exact command that replays
// that single seed.
//
// Knobs (env):
//   STRESS_ITER        rounds per scenario (default 6 — the suite stays fast;
//                      campaigns run with e.g. STRESS_ITER=80)
//   STRESS_SEED        master seed the per-round seeds are drawn from
//   STRESS_SEEDS       comma-separated round seeds to replay instead
//   STRESS_LATENCY_MS  max seeded latency per upstream call (default 8)
//   STRESS_OUT_DIR     where the JSON tables go
//                      (default artifacts/stress-route-post-v1-auth-logout-concurrency/latest/)
//
// Replay is deterministic in what the harness CONTROLS (seeds, offsets,
// injected latencies and faults); the OS timer resolution can still order
// two lanes with equal offsets differently, which is why a failing seed is
// re-run several times before it is reported as flaky vs. deterministic.

export function envInt(
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || (n === 0 && !allowZero)) return fallback;
  return Math.floor(n);
}

export const STRESS_ITER = envInt("STRESS_ITER", 6);
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8, true);
/** Upper bound on one round's wall time: a round is a handful of requests
 * over sub-10ms fake latencies, so anything near this is a stall. */
export const ROUND_BOUND_MS = envInt("STRESS_ROUND_BOUND_MS", 5_000);

/** Same generator as xc_concurrency_harness.ts (mulberry32) so seeds mean the
 * same thing across the concurrency suites. */
export class Rng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive +
      Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The round seeds of a scenario: STRESS_SEEDS verbatim when set, otherwise
 * STRESS_ITER draws from a generator keyed by master seed × scenario name, so
 * a `--filter`ed replay of one scenario sees exactly its seeds from the full
 * campaign. */
export function roundSeeds(scenario: string): number[] {
  const explicit = Deno.env.get("STRESS_SEEDS");
  if (explicit) {
    const seeds = explicit
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (seeds.length > 0) return seeds;
  }
  const master = new Rng((STRESS_SEED ^ fnv1a(scenario)) >>> 0);
  return Array.from({ length: STRESS_ITER }, () => master.int(1, 0x7fffffff));
}

/** A /16 per scenario (from its name), a /24 per round, a host per lane —
 * the edge fn's in-memory per-IP windows outlive any fake reset, so no two
 * rounds may share an IP. The 172.16/12 block keeps clear of the 10/8 and
 * 198.51/16 ranges the other suites use. */
export function laneIp(scenario: string, round: number, lane: number): string {
  const h = fnv1a(scenario);
  return `172.${16 + (h & 15)}.${(round + ((h >> 4) & 0xff)) & 255}.${
    lane & 255
  }`;
}

export interface LaneResult {
  lane: string;
  at: number;
  status: number;
  body: string;
  startedAt: number;
  endedAt: number;
}

export interface Lane {
  name: string;
  /** Start offset (ms) from the burst's t0. */
  at: number;
  run: () => Promise<Response>;
}

/** Fire every lane at its seeded offset and wait for all of them. Bodies are
 * fully read so nothing leaks past the test. */
export async function runLanes(lanes: Lane[]): Promise<LaneResult[]> {
  const t0 = performance.now();
  return await Promise.all(
    lanes.map(async (lane) => {
      if (lane.at > 0) await sleep(lane.at);
      const startedAt = performance.now() - t0;
      const response = await lane.run();
      const body = await response.text().catch(() => "");
      return {
        lane: lane.name,
        at: lane.at,
        status: response.status,
        body,
        startedAt: Math.round(startedAt * 100) / 100,
        endedAt: Math.round((performance.now() - t0) * 100) / 100,
      };
    }),
  );
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function errorMessageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed?.error?.message ?? "";
  } catch {
    return "";
  }
}

/** Collects invariant violations for one round. */
export class Checks {
  readonly violations: string[] = [];
  that(holds: boolean, detail: string): void {
    if (!holds) this.violations.push(detail);
  }
  equal(actual: unknown, expected: unknown, what: string): void {
    this.that(
      actual === expected,
      `${what}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

export interface RoundRow {
  scenario: string;
  round: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  durationMs: number;
  lanes: number;
  statuses: Record<string, number>;
  inputs: Record<string, unknown>;
  observations: Record<string, unknown>;
  violations: string[];
  replay: string;
}

export interface CampaignTable {
  file: string;
  masterSeed: number;
  iter: number;
  latencyMaxMs: number;
  startedAt: string;
  finishedAt: string;
  totals: { rounds: number; held: number; broken: number; lanes: number };
  perScenario: Record<
    string,
    { rounds: number; held: number; broken: number; lanes: number }
  >;
  failingSeeds: Array<
    { scenario: string; seed: number; violations: string[]; replay: string }
  >;
  rows: RoundRow[];
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-post-v1-auth-logout-concurrency/latest/",
    import.meta.url,
  ).pathname;
}

export function replayCommand(
  file: string,
  scenario: string,
  seed: number,
): string {
  return `STRESS_SEEDS=${seed} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${scenario}"`;
}

/** One JSON table per test module; rows are appended as rounds finish and the
 * file is rewritten after every scenario so a crash mid-campaign still leaves
 * the rows that ran. */
export class Campaign {
  readonly rows: RoundRow[] = [];
  private readonly startedAt = new Date().toISOString();
  constructor(readonly file: string) {}

  add(row: RoundRow): void {
    this.rows.push(row);
  }

  table(): CampaignTable {
    const perScenario: CampaignTable["perScenario"] = {};
    let held = 0;
    let broken = 0;
    let lanes = 0;
    for (const row of this.rows) {
      const bucket = (perScenario[row.scenario] ??= {
        rounds: 0,
        held: 0,
        broken: 0,
        lanes: 0,
      });
      bucket.rounds += 1;
      bucket.lanes += row.lanes;
      lanes += row.lanes;
      if (row.outcome === "HELD") {
        bucket.held += 1;
        held += 1;
      } else {
        bucket.broken += 1;
        broken += 1;
      }
    }
    return {
      file: this.file,
      masterSeed: STRESS_SEED,
      iter: STRESS_ITER,
      latencyMaxMs: STRESS_LATENCY_MS,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      totals: { rounds: this.rows.length, held, broken, lanes },
      perScenario,
      failingSeeds: this.rows
        .filter((row) => row.outcome === "BROKEN")
        .map((row) => ({
          scenario: row.scenario,
          seed: row.seed,
          violations: row.violations,
          replay: row.replay,
        })),
      rows: this.rows,
    };
  }

  async write(): Promise<string> {
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}${this.file.replace(/\.test\.ts$/, "")}.json`;
    await Deno.writeTextFile(path, JSON.stringify(this.table(), null, 2));
    return path;
  }
}

/** Run `fn` with Date.now() shifted by `offsetMs`; the edge function, its
 * cache and its rate-limit windows all read Date.now(), timers do not. */
export async function withClockOffset<T>(
  offsetMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Shift Date.now() by `offsetMs` from now on (until `restore` is called). */
export function shiftClock(offsetMs: number): () => void {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + offsetMs + (realNow() - base);
  return () => {
    Date.now = realNow;
  };
}
