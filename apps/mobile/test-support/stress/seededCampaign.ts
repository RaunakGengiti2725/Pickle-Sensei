/**
 * Seeded randomized long-run campaign runner shared by the suites under
 * `__tests__/stress/`.
 *
 * Every sequence is fully determined by `(seed, length)`: the generator draws
 * an action list from a mulberry32 stream seeded with `seed`, the executor
 * replays it against the module under test and checks the invariants after
 * every step. Failures are minimized by greedy single-action deletion (the
 * failing predicate is re-executed, never guessed) and the campaign result
 * is a JSON table `seed → outcome` written to `STRESS_OUT` (default
 * `apps/mobile/artifacts/stress/<campaign>.json`).
 *
 * Knobs (all optional):
 *   STRESS_ITER        number of sequences (default 120 — fast enough for CI)
 *   STRESS_SEED        base seed (default 20260905); sequence i uses base + i
 *   STRESS_MIN_LEN     minimum sequence length (default 5)
 *   STRESS_MAX_LEN     maximum sequence length (default 60)
 *   STRESS_ONLY_SEED   replay exactly one seed (comma-separated list allowed)
 *   STRESS_OUT         output directory for the JSON tables
 *   STRESS_DETERMINISM how many passing seeds to re-run twice (default 25)
 */

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  /** Weighted pick: `[[item, weight], …]`. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('pick from empty list');
      return items[int(0, items.length - 1)] as T;
    },
    chance: probability => next() < probability,
    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [item, weight] of entries) {
        roll -= weight;
        if (roll < 0) return item;
      }
      return entries[entries.length - 1]![0];
    },
  };
}

/** Deterministic stand-in for a v4 UUID (server-minted ids in the models). */
export function seededUuid(rng: Rng): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[8 + rng.int(0, 3)];
    else out += hex[rng.int(0, 15)];
  }
  return out;
}

// ─── Campaign configuration ──────────────────────────────────────────────────

export interface CampaignConfig {
  iterations: number;
  baseSeed: number;
  minLen: number;
  maxLen: number;
  onlySeeds: number[] | null;
  outDir: string;
  determinismSamples: number;
  /** Write the full trace of every seed (not only broken ones). */
  fullTraces: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${raw}`);
  }
  return Math.floor(value);
}

export function campaignConfig(): CampaignConfig {
  const only = process.env.STRESS_ONLY_SEED;
  return {
    iterations: envInt('STRESS_ITER', 120),
    baseSeed: envInt('STRESS_SEED', 20260905),
    minLen: envInt('STRESS_MIN_LEN', 5),
    maxLen: envInt('STRESS_MAX_LEN', 60),
    onlySeeds:
      only && only.trim()
        ? only.split(',').map(part => {
            const n = Number(part.trim());
            if (!Number.isSafeInteger(n)) {
              throw new Error(
                `STRESS_ONLY_SEED entry is not an integer: ${part}`,
              );
            }
            return n;
          })
        : null,
    outDir:
      process.env.STRESS_OUT ??
      join(__dirname, '..', '..', 'artifacts', 'stress'),
    determinismSamples: envInt('STRESS_DETERMINISM', 25),
    fullTraces: process.env.STRESS_TRACES === '1',
  };
}

// ─── Sequence execution ──────────────────────────────────────────────────────

export interface StepTrace {
  step: number;
  action: string;
  outcome: string;
}

export interface Execution {
  trace: StepTrace[];
  /** First invariant violation, or null when every step held. */
  violation: { step: number; message: string } | null;
}

export interface SequenceSpec<A> {
  /** Draws `length` actions from the seeded stream. */
  generate(rng: Rng, length: number): A[];
  /**
   * Replays `actions` from a fresh model and returns the trace. `rng` is a
   * SEPARATE stream (seed ^ 0x9e3779b9) for server-side randomness such as
   * minted ids, so the action list and the execution are independently
   * reproducible.
   */
  execute(actions: A[], rng: Rng, seed: number): Promise<Execution>;
  describeAction(action: A): string;
  /** Coarse label for the coverage histogram (defaults to describeAction). */
  coverageKey?(action: A): string;
}

export interface SequenceResult {
  seed: number;
  length: number;
  status: 'held' | 'broken';
  failedStep: number | null;
  violation: string | null;
  trace: StepTrace[];
  /** Minimal action subsequence that still reproduces the violation. */
  minimized: { actions: string[]; violation: string } | null;
  deterministic: boolean | null;
}

export interface CampaignSummary {
  campaign: string;
  config: Omit<CampaignConfig, 'onlySeeds'> & { onlySeeds: number[] | null };
  sequencesExecuted: number;
  stepsExecuted: number;
  held: number;
  broken: number;
  brokenSeeds: number[];
  determinismChecked: number;
  nonDeterministicSeeds: number[];
  minimizationReplays: number;
  /** Executed steps per coarse action label — proves the generator reached
   * every branch it was meant to. */
  coverage: Record<string, number>;
}

export interface CampaignOutput {
  summary: CampaignSummary;
  results: SequenceResult[];
}

const executionRng = (seed: number): Rng =>
  mulberry32((seed ^ 0x9e3779b9) >>> 0);

async function runOnce<A>(
  spec: SequenceSpec<A>,
  seed: number,
  actions: A[],
): Promise<Execution> {
  return spec.execute(actions, executionRng(seed), seed);
}

/** Greedy one-at-a-time deletion until no single action can be removed while
 * the sequence still violates an invariant. Returns the surviving actions and
 * the number of replays spent. */
async function minimize<A>(
  spec: SequenceSpec<A>,
  seed: number,
  actions: A[],
): Promise<{ actions: A[]; violation: string; replays: number }> {
  let current = actions;
  let violation = '';
  let replays = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1));
      if (candidate.length === 0) continue;
      const result = await runOnce(spec, seed, candidate);
      replays += 1;
      if (result.violation) {
        current = candidate;
        violation = result.violation.message;
        changed = true;
        break;
      }
    }
  }
  if (!violation) {
    const result = await runOnce(spec, seed, current);
    replays += 1;
    violation = result.violation?.message ?? '(violation vanished on replay)';
  }
  return { actions: current, violation, replays };
}

const traceKey = (trace: StepTrace[]): string => JSON.stringify(trace);

export async function runCampaign<A>(
  campaign: string,
  spec: SequenceSpec<A>,
  config: CampaignConfig = campaignConfig(),
): Promise<CampaignOutput> {
  const seeds =
    config.onlySeeds ??
    Array.from({ length: config.iterations }, (_, i) => config.baseSeed + i);
  const results: SequenceResult[] = [];
  let stepsExecuted = 0;
  let minimizationReplays = 0;
  const nonDeterministicSeeds: number[] = [];
  let determinismChecked = 0;
  const coverage: Record<string, number> = {};

  for (const [index, seed] of seeds.entries()) {
    const rng = mulberry32(seed);
    const length = rng.int(config.minLen, config.maxLen);
    const actions = spec.generate(rng, length);
    const execution = await runOnce(spec, seed, actions);
    stepsExecuted += execution.trace.length;
    for (const action of actions.slice(0, execution.trace.length)) {
      const key = spec.coverageKey
        ? spec.coverageKey(action)
        : spec.describeAction(action);
      coverage[key] = (coverage[key] ?? 0) + 1;
    }

    const result: SequenceResult = {
      seed,
      length: actions.length,
      status: execution.violation ? 'broken' : 'held',
      failedStep: execution.violation?.step ?? null,
      violation: execution.violation?.message ?? null,
      trace: execution.trace,
      minimized: null,
      deterministic: null,
    };

    // Determinism: every broken seed and a spread sample of held seeds are
    // executed a second time from scratch; the traces must be identical.
    const sampleEvery =
      config.determinismSamples > 0
        ? Math.max(1, Math.floor(seeds.length / config.determinismSamples))
        : 0;
    const checkDeterminism =
      execution.violation !== null ||
      (sampleEvery > 0 && index % sampleEvery === 0);
    if (checkDeterminism) {
      const again = await runOnce(spec, seed, actions);
      stepsExecuted += again.trace.length;
      determinismChecked += 1;
      result.deterministic =
        traceKey(again.trace) === traceKey(execution.trace) &&
        (again.violation?.message ?? null) ===
          (execution.violation?.message ?? null);
      if (!result.deterministic) nonDeterministicSeeds.push(seed);
    }

    if (execution.violation) {
      const min = await minimize(spec, seed, actions);
      minimizationReplays += min.replays;
      result.minimized = {
        actions: min.actions.map(a => spec.describeAction(a)),
        violation: min.violation,
      };
    }
    results.push(result);
  }

  const broken = results.filter(r => r.status === 'broken');
  const summary: CampaignSummary = {
    campaign,
    config: { ...config },
    sequencesExecuted: results.length,
    stepsExecuted,
    held: results.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    determinismChecked,
    nonDeterministicSeeds,
    minimizationReplays,
    coverage: Object.fromEntries(
      Object.entries(coverage).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };

  mkdirSync(config.outDir, { recursive: true });
  writeFileSync(
    join(config.outDir, `${campaign}.summary.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(config.outDir, `${campaign}.results.json`),
    JSON.stringify(
      results.map(r => ({
        seed: r.seed,
        length: r.length,
        status: r.status,
        failedStep: r.failedStep,
        violation: r.violation,
        deterministic: r.deterministic,
        minimized: r.minimized,
        // Full traces only for broken seeds keep the table reviewable;
        // any held seed replays from its number alone.
        trace: r.status === 'broken' || config.fullTraces ? r.trace : undefined,
      })),
      null,
      2,
    ),
  );
  return { summary, results };
}

/** Human-readable failure digest for the jest assertion message. */
export function describeFailures(output: CampaignOutput): string {
  const lines: string[] = [];
  for (const r of output.results) {
    if (r.status === 'held' && r.deterministic !== false) continue;
    lines.push(
      `seed=${r.seed} step=${r.failedStep ?? '-'} deterministic=${String(
        r.deterministic,
      )}: ${r.violation ?? 'trace differed between two runs of the same seed'}`,
    );
    if (r.minimized) {
      lines.push(`  minimized (${r.minimized.actions.length} actions):`);
      for (const a of r.minimized.actions) lines.push(`    ${a}`);
    }
  }
  return lines.join('\n');
}

// ─── Fake-fetch plumbing shared by the HTTP-client suites ────────────────────

/** How the simulated server answers one request. */
export type WireFault =
  | { kind: 'ok'; status?: number; body: unknown }
  | { kind: 'http'; status: number; body: unknown }
  | { kind: 'http_nonjson'; status: number }
  | { kind: 'ok_nonjson' }
  | { kind: 'network' }
  | { kind: 'hang' };

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, `undefined` when no body was sent. */
  body: unknown;
  rawBody: string | undefined;
  hadSignal: boolean;
}

export interface FakeFetch {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
  /** Installs the answer for the next request(s), in order. */
  queue(...faults: WireFault[]): void;
  /** Responses that were never consumed (a bug in the harness or an
   * under-fetching client). */
  pending(): number;
}

function responseLike(status: number, json: () => Promise<unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json,
  } as unknown as Response;
}

/** A fetch double that records every request and answers from a queue. A
 * `hang` fault only settles when the caller aborts through `init.signal` —
 * exactly how a stalled socket behaves under the client's own deadline. */
export function createFakeFetch(): FakeFetch {
  const requests: RecordedRequest[] = [];
  const answers: WireFault[] = [];
  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown;
    if (rawBody !== undefined) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = Symbol('unparseable-body');
      }
    }
    requests.push({
      url: input,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body,
      rawBody,
      hadSignal: Boolean(init?.signal),
    });
    const fault = answers.shift();
    if (!fault) {
      return Promise.reject(
        new Error('fake fetch: no queued answer for ' + input),
      );
    }
    switch (fault.kind) {
      case 'ok':
        return Promise.resolve(
          responseLike(fault.status ?? 200, () => Promise.resolve(fault.body)),
        );
      case 'http':
        return Promise.resolve(
          responseLike(fault.status, () => Promise.resolve(fault.body)),
        );
      case 'http_nonjson':
        return Promise.resolve(
          responseLike(fault.status, () =>
            Promise.reject(new SyntaxError('Unexpected token < in JSON')),
          ),
        );
      case 'ok_nonjson':
        return Promise.resolve(
          responseLike(200, () =>
            Promise.reject(new SyntaxError('Unexpected end of JSON input')),
          ),
        );
      case 'network':
        return Promise.reject(new TypeError('Network request failed'));
      case 'hang':
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (!signal) return; // never settles — the client must own a deadline
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
    }
  };
  return {
    fetchFn,
    requests,
    queue: (...faults) => {
      answers.push(...faults);
    },
    pending: () => answers.length,
  };
}

/**
 * Awaits a client call under jest fake timers. The client owns a 15 s
 * AbortController deadline, so a `hang` answer is driven by advancing the
 * clock: first to one tick before the deadline (the call must still be
 * pending), then across it. Returns the settled outcome plus whether the
 * call was still pending right before the deadline. `rounds` > 1 drives
 * further deadlines for clients that retry after a timeout (each retry may
 * stall for a full deadline again); `pendingBeforeDeadline` reports the
 * first round.
 */
export async function settle<T>(
  promise: Promise<T>,
  deadlineMs: number,
  rounds = 1,
): Promise<
  | { kind: 'resolved'; value: T; pendingBeforeDeadline: boolean }
  | { kind: 'rejected'; error: unknown; pendingBeforeDeadline: boolean }
  | { kind: 'stuck' }
> {
  type Settled =
    { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown };
  const box: { settled: Settled | null } = { settled: null };
  const tracked = promise.then(
    value => {
      box.settled = { kind: 'resolved', value };
    },
    (error: unknown) => {
      box.settled = { kind: 'rejected', error };
    },
  );
  const current = (): Settled | null => box.settled;
  // Let microtasks (non-hanging responses) settle first.
  for (let i = 0; i < 12 && current() === null; i += 1) {
    await Promise.resolve();
  }
  const early = current();
  if (early) {
    await tracked;
    return { ...early, pendingBeforeDeadline: false };
  }
  await jest.advanceTimersByTimeAsync(deadlineMs - 1);
  const pendingBeforeDeadline = current() === null;
  await jest.advanceTimersByTimeAsync(1);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12 && current() === null; i += 1) {
      await Promise.resolve();
    }
  };
  await flush();
  for (let round = 1; round < rounds && current() === null; round += 1) {
    // Retry-after-timeout clients issue a new request that may stall again.
    await jest.advanceTimersByTimeAsync(deadlineMs);
    await flush();
  }
  const late = current();
  if (late === null) return { kind: 'stuck' };
  await tracked;
  return { ...late, pendingBeforeDeadline };
}

/** Stable stringification for traces: sorts object keys so two runs of the
 * same seed compare byte-for-byte. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    if (typeof v === 'symbol') return String(v);
    if (v === undefined) return '<undefined>';
    return v;
  });
}
