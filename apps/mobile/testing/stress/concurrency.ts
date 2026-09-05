/**
 * Seeded concurrency harness for the account clients
 * (src/account/{deletion,consentApi,onboarding,deviceContext}.ts).
 *
 * Every campaign iteration is replayable from its seed: the seed drives the
 * number of concurrent calls, which actor/session each uses, the transport
 * outcome of every request (status, body shape, network throw, hang until
 * the client's own deadline, late reply that ignores abort) and the virtual
 * time at which each reply lands. Requests settle through Jest's modern fake
 * timers, so interleavings are deterministic and a whole campaign of
 * thousands of iterations runs in seconds.
 *
 * Scale: `STRESS_ITER` iterations per campaign (default small so the suites
 * stay cheap in CI); `STRESS_SEED=<n>` replays exactly one seed. Results are
 * appended as one JSON row per iteration to
 * `artifacts/stress/<STRESS_RUN_ID>/<suite>.ndjson` (repo-root relative,
 * gitignored) so a failing seed can be pasted straight into a finding.
 */
import { seededRandom } from '../xcBehavioral/evidence';

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export { seededRandom };

export type Rng = () => number;

export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() on an empty list');
  return items[Math.floor(rng() * items.length)] as T;
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

/** Deterministic seeds for a campaign: `STRESS_SEED` pins one, otherwise
 * `STRESS_ITER` seeds derived from the campaign name (FNV-1a) so the same
 * scale always covers the same inputs. */
export function campaignSeeds(campaign: string, defaultIter: number): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned) >>> 0];
  const iter = Number(process.env['STRESS_ITER'] ?? String(defaultIter));
  let hash = 2166136261;
  for (const ch of campaign) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < iter; i += 1) seeds.push((hash + i * 7919) >>> 0);
  return seeds;
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function stressArtifactDir(): string {
  return path.join(repoRoot(), 'artifacts', 'stress', RUN_ID);
}

export interface IterationRow {
  suite: string;
  campaign: string;
  seed: number;
  plan: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: 'pass' | 'fail';
  error?: string;
}

export function appendRow(row: IterationRow): void {
  const dir = stressArtifactDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, `${row.suite}.ndjson`),
    `${JSON.stringify(row)}\n`,
  );
}

/** Runs one seeded iteration, records its row whether it passes or throws,
 * and re-throws so Jest reports the failing seed. */
export async function runIteration(
  suite: string,
  campaign: string,
  seed: number,
  body: (rng: Rng) => Promise<{
    plan: Record<string, unknown>;
    observed: Record<string, unknown>;
    check: () => void;
  }>,
): Promise<Record<string, unknown>> {
  const rng = seededRandom(seed);
  let plan: Record<string, unknown> = {};
  let observed: Record<string, unknown> = {};
  try {
    const result = await body(rng);
    plan = result.plan;
    observed = result.observed;
    result.check();
    appendRow({ suite, campaign, seed, plan, observed, verdict: 'pass' });
    return observed;
  } catch (error) {
    appendRow({
      suite,
      campaign,
      seed,
      plan,
      observed,
      verdict: 'fail',
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `[${suite}/${campaign} seed=${seed}] ${
        error instanceof Error ? error.message : String(error)
      }\nreplay: STRESS_SEED=${seed} npx jest __tests__/stress/concurrency/${suite}.stress.test.ts`,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Scheduled transport                                                       */
/* ------------------------------------------------------------------------ */

/** What the fake network does with one request. */
export type ReplyKind =
  /** 2xx with the body the scenario supplies. */
  | 'ok'
  /** Non-2xx with an `{ error: { message } }` body. */
  | 'http_error'
  /** 2xx whose body is not JSON at all. */
  | 'ok_non_json'
  /** fetch itself rejects (DNS, TLS, offline). */
  | 'throw'
  /** Never replies; rejects only when the client aborts. */
  | 'hang'
  /** Replies after the client's deadline and IGNORES the abort signal. */
  | 'late_ignores_abort';

export interface ReplyPlan {
  kind: ReplyKind;
  /** Virtual ms after the request is issued at which the reply lands. */
  delayMs: number;
  status: number;
  body: unknown;
}

export interface IssuedRequest {
  callId: string;
  seq: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  issuedAtMs: number;
  signal: AbortSignal | undefined;
  abortedAtMs: number | null;
  plan: ReplyPlan;
}

export const CLIENT_DEADLINE_MS = 15_000;

/** Statuses the clients classify differently — kept as a table so every
 * campaign draws from the same vocabulary. */
export const HTTP_ERROR_STATUSES = [
  400, 401, 403, 404, 409, 429, 500, 502, 503,
];

export function planReply(
  rng: Rng,
  okBody: () => unknown,
  weights: Partial<Record<ReplyKind, number>> = {},
): ReplyPlan {
  const table: Array<[ReplyKind, number]> = [
    ['ok', weights.ok ?? 50],
    ['http_error', weights.http_error ?? 22],
    ['ok_non_json', weights.ok_non_json ?? 5],
    ['throw', weights.throw ?? 8],
    ['hang', weights.hang ?? 10],
    ['late_ignores_abort', weights.late_ignores_abort ?? 5],
  ];
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  let kind: ReplyKind = 'ok';
  for (const [k, w] of table) {
    if (roll < w) {
      kind = k;
      break;
    }
    roll -= w;
  }
  switch (kind) {
    case 'ok':
      return {
        kind,
        delayMs: randomInt(rng, 0, CLIENT_DEADLINE_MS - 1),
        status: 200,
        body: okBody(),
      };
    case 'http_error': {
      const status = pick(rng, HTTP_ERROR_STATUSES);
      return {
        kind,
        delayMs: randomInt(rng, 0, CLIENT_DEADLINE_MS - 1),
        status,
        body: {
          error: { code: `test.${status}`, message: `server said ${status}` },
        },
      };
    }
    case 'ok_non_json':
      return {
        kind,
        delayMs: randomInt(rng, 0, CLIENT_DEADLINE_MS - 1),
        status: 200,
        body: null,
      };
    case 'throw':
      return {
        kind,
        delayMs: randomInt(rng, 0, CLIENT_DEADLINE_MS - 1),
        status: 0,
        body: null,
      };
    case 'hang':
      return { kind, delayMs: Number.POSITIVE_INFINITY, status: 0, body: null };
    case 'late_ignores_abort':
      return {
        kind,
        delayMs: randomInt(
          rng,
          CLIENT_DEADLINE_MS + 1,
          CLIENT_DEADLINE_MS + 5_000,
        ),
        status: 200,
        body: okBody(),
      };
  }
}

function makeResponse(
  status: number,
  body: unknown,
  nonJson: boolean,
): Response {
  const text = nonJson ? '<html>upstream gateway</html>' : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      'Content-Type': nonJson ? 'text/html' : 'application/json',
    },
  });
}

/**
 * A fake network whose replies are scheduled on the (fake) timer wheel. Each
 * logical client call gets its own `fetchFor(callId, planner)` so the
 * request can always be attributed to the call that made it — even when the
 * client issues more than one request per call (onboarding's retry).
 */
export class ScheduledTransport {
  readonly requests: IssuedRequest[] = [];

  /** Clock used for issue/abort stamps; defaults to the (fake) wall clock.
   * Campaigns that skew `Date.now()` pass a monotonic virtual clock. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Highest number of requests simultaneously in flight. */
  peakInFlight = 0;
  private inFlight = 0;

  fetchFor(
    callId: string,
    planner: (request: {
      url: string;
      method: string;
      body: unknown;
      /** Global issue order across every call. */
      seq: number;
      /** 0-based index of this request within its own call. */
      attempt: number;
    }) => ReplyPlan,
  ): (input: string, init?: RequestInit) => Promise<Response> {
    return (input, init) => {
      const method = init?.method ?? 'GET';
      const rawBody = init?.body;
      const body =
        typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined;
      const seq = this.requests.length;
      const attempt = this.requestsFor(callId).length;
      const plan = planner({ url: input, method, body, seq, attempt });
      const headers = {
        ...(init?.headers as Record<string, string> | undefined),
      };
      const issued: IssuedRequest = {
        callId,
        seq,
        url: input,
        method,
        headers,
        body,
        issuedAtMs: this.now(),
        signal: init?.signal ?? undefined,
        abortedAtMs: null,
        plan,
      };
      this.requests.push(issued);
      this.inFlight += 1;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      return new Promise<Response>((resolve, reject) => {
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          this.inFlight -= 1;
          fn();
        };
        const onAbort = () => {
          issued.abortedAtMs = this.now();
          if (plan.kind === 'late_ignores_abort') return;
          finish(() =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        };
        issued.signal?.addEventListener('abort', onAbort);
        if (plan.kind === 'hang') return;
        setTimeout(() => {
          finish(() => {
            switch (plan.kind) {
              case 'throw':
                reject(new TypeError('Network request failed'));
                return;
              case 'ok_non_json':
                resolve(makeResponse(plan.status, null, true));
                return;
              default:
                resolve(makeResponse(plan.status, plan.body, false));
            }
          });
        }, plan.delayMs);
      });
    };
  }

  requestsFor(callId: string): IssuedRequest[] {
    return this.requests.filter(r => r.callId === callId);
  }
}

export type Settled<T> =
  | { status: 'fulfilled'; value: T; settledAtMs: number }
  | { status: 'rejected'; reason: unknown; settledAtMs: number };

/** Promise.allSettled that also stamps the virtual time of settlement. */
export function track<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    value => ({ status: 'fulfilled', value, settledAtMs: Date.now() }),
    (reason: unknown) => ({
      status: 'rejected',
      reason,
      settledAtMs: Date.now(),
    }),
  );
}

/** Advance fake time in bounded steps until every tracked promise settled
 * or the budget is exhausted (a deadlock shows up as an unsettled entry,
 * never as a hung test). */
export async function drain(
  settled: () => boolean,
  budgetMs: number,
  stepMs = 250,
  onStep: (elapsedMs: number) => void = () => {},
): Promise<number> {
  let elapsed = 0;
  while (!settled() && elapsed < budgetMs) {
    // Timers firing inside (elapsed, elapsed + stepMs] are stamped with the
    // step's end, so a monotonic clock fed by onStep stays consistent for
    // "issued at t, aborted at t + deadline" arithmetic.
    elapsed += stepMs;
    onStep(elapsed);
    await jest.advanceTimersByTimeAsync(stepMs);
  }
  // Let trailing microtasks (post-response JSON parsing) run.
  await jest.advanceTimersByTimeAsync(0);
  return elapsed;
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
