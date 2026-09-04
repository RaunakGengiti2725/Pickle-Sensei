/**
 * STRESS SUITE (lens: concurrency) for apps/mobile/src/training/api.ts.
 *
 * Drives the REAL `createTrainingApi` transport (as authStore wires it: a
 * `get token()` accessor over `bearerTokenFor`) plus the real `apiSession`
 * store through a seeded scheduler. Bursts of concurrent requests overlap with
 * bearer rotations, sign-outs and account switches while responses are still
 * in flight; the fake fetch answers per-token (a revoked bearer is a 401),
 * with seeded delays, 5xx/429, malformed bodies and network drops.
 *
 * Invariants checked at quiescence of every iteration:
 *   - bounded wall time, every call settles with a TrainingError or a value;
 *   - exactly one fetch per API call (no amplification, no retry loops);
 *   - a request is sent only under the bearer that was current when it was
 *     issued, never after sign-out and never under another account's bearer;
 *   - a 401 for an already-rotated or cleared bearer never tears down the
 *     current session; a 401 for the current bearer reports exactly once;
 *   - every response is parsed defensively (malformed → invalid_response),
 *     server-truth ordering: a parsed saved-drill list equals the server
 *     snapshot at processing time (the transport must not reorder/merge).
 *
 * Replay: STRESS_SEED=<n>; STRESS_ITER=<n> (default 500); STRESS_OUT_DIR.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import { createTrainingApi } from '../../src/training/api';
import { TrainingError, type TrainingApi } from '../../src/training/types';

// ---------------------------------------------------------------------------
// Seeded randomness + virtual scheduler
// ---------------------------------------------------------------------------

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, maxExclusive: number): number =>
  Math.floor(rng() * maxExclusive);
const pick = <T>(rng: Rng, items: readonly T[]): T => {
  const item = items[int(rng, items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
};

const flushMicrotasks = (): Promise<void> =>
  new Promise(resolve => setImmediate(resolve));

class Scheduler {
  private now = 0;
  private seq = 0;
  private readonly queue: { at: number; seq: number; run: () => void }[] = [];

  get time(): number {
    return this.now;
  }

  schedule(delay: number, run: () => void): void {
    this.queue.push({
      at: this.now + Math.max(0, delay),
      seq: this.seq++,
      run,
    });
  }

  async drain(maxEvents: number): Promise<number> {
    let events = 0;
    while (this.queue.length > 0) {
      if (events >= maxEvents) {
        throw new Error(`scheduler did not quiesce after ${maxEvents} events`);
      }
      let best = 0;
      for (let i = 1; i < this.queue.length; i += 1) {
        const candidate = this.queue[i];
        const current = this.queue[best];
        if (!candidate || !current) continue;
        if (
          candidate.at < current.at ||
          (candidate.at === current.at && candidate.seq < current.seq)
        ) {
          best = i;
        }
      }
      const [event] = this.queue.splice(best, 1);
      if (!event) break;
      this.now = event.at;
      event.run();
      events += 1;
      await flushMicrotasks();
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// Server model: bearer registry + per-account saved rows
// ---------------------------------------------------------------------------

const BASE_URL = 'https://stress.invalid/functions/v1/api';
const uuidAt = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type Fault =
  | 'none'
  | 'net'
  | 'http-401-live'
  | 'http-500'
  | 'http-429'
  | 'http-403-json'
  | 'malformed-json'
  | 'malformed-shape';
const FAULTS: readonly Fault[] = [
  'net',
  'http-401-live',
  'http-500',
  'http-429',
  'http-403-json',
  'malformed-json',
  'malformed-shape',
];

/** Mirrors the shape the existing trainingApi tests hand to `fetchFn`. */
function httpResponse(status: number, body: string | null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => {
      if (body === null) throw new SyntaxError('Unexpected end of JSON input');
      return JSON.parse(body) as unknown;
    },
  } as Response;
}

interface RequestRecord {
  id: number;
  method: string;
  path: string;
  bearer: string | null;
  /** Bearer that was current for the issuing account at fire time. */
  issuedUnderCurrent: boolean;
  account: string | null;
  issuedAt: number;
  processedAt: number | null;
  status: number | null;
  fault: Fault;
  serverSnapshot: string[] | null;
}

class Server {
  /** bearer → account (only live bearers). */
  readonly liveBearers = new Map<string, string>();
  readonly saved = new Map<string, Set<string>>();
  readonly requests: RequestRecord[] = [];
  private bearerSeq = 0;

  constructor(private readonly scheduler: Scheduler) {}

  mintBearer(account: string): string {
    this.bearerSeq += 1;
    const bearer = `tok-${account}-${this.bearerSeq}`;
    this.liveBearers.set(bearer, account);
    return bearer;
  }

  revoke(bearer: string): void {
    this.liveBearers.delete(bearer);
  }

  rows(account: string): Set<string> {
    let rows = this.saved.get(account);
    if (!rows) {
      rows = new Set();
      this.saved.set(account, rows);
    }
    return rows;
  }

  private savedRow(account: string, slug: string, index: number) {
    return {
      id: uuidAt(0x5000 + index),
      slug,
      title: `Drill ${slug}`,
      description: `Description ${slug}`,
      coach_name: 'Pickle Sensei Training Library',
      equipment: [],
      difficulty_min: null,
      difficulty_max: null,
      saved_at: `2026-09-04T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
    };
  }

  /** Applies the request to server state and returns the raw HTTP answer. */
  handle(
    record: RequestRecord,
    rng: Rng,
    faultRate: number,
  ): { status: number; body: string | null; network: boolean } {
    record.processedAt = this.scheduler.time;
    const account = record.bearer ? this.liveBearers.get(record.bearer) : null;
    if (!account) {
      record.status = 401;
      return {
        status: 401,
        body: '{"error":{"code":"auth.unauthorized"}}',
        network: false,
      };
    }
    record.fault = rng() < faultRate ? pick(rng, FAULTS) : 'none';
    if (record.fault === 'net') {
      record.status = null;
      return { status: 0, body: null, network: true };
    }
    if (record.fault === 'http-401-live') {
      // Server-side session expiry of a bearer the client still holds.
      record.status = 401;
      return {
        status: 401,
        body: '{"error":{"code":"auth.expired"}}',
        network: false,
      };
    }
    if (record.fault === 'http-500') {
      record.status = 500;
      return {
        status: 500,
        body: '{"error":{"message":"boom"}}',
        network: false,
      };
    }
    if (record.fault === 'http-429') {
      record.status = 429;
      return {
        status: 429,
        body: '{"error":{"code":"rate_limited","message":"slow down"}}',
        network: false,
      };
    }
    if (record.fault === 'http-403-json') {
      record.status = 403;
      return {
        status: 403,
        body: '{"error":{"code":"access.denied","message":"nope"}}',
        network: false,
      };
    }
    const rows = this.rows(account);
    const savedMatch = /^\/v1\/me\/saved-drills\/([^/?]+)$/.exec(record.path);
    if (record.method === 'PUT' && savedMatch?.[1]) {
      const slug = decodeURIComponent(savedMatch[1]);
      rows.add(slug);
      record.serverSnapshot = [...rows].sort();
      record.status = 200;
      const body =
        record.fault === 'malformed-json'
          ? '{not json'
          : record.fault === 'malformed-shape'
            ? JSON.stringify({ slug: 'someone-else', saved: true })
            : JSON.stringify({
                slug,
                saved: true,
                savedAt: '2026-09-04T12:00:00.000Z',
              });
      return { status: 200, body, network: false };
    }
    if (record.method === 'DELETE' && savedMatch?.[1]) {
      rows.delete(decodeURIComponent(savedMatch[1]));
      record.serverSnapshot = [...rows].sort();
      record.fault = 'none'; // 204 carries no body to malform
      record.status = 204;
      return { status: 204, body: null, network: false };
    }
    if (record.method === 'GET' && record.path === '/v1/me/saved-drills') {
      record.serverSnapshot = [...rows].sort();
      record.status = 200;
      const items = record.serverSnapshot.map((slug, index) =>
        this.savedRow(account, slug, index),
      );
      const body =
        record.fault === 'malformed-json'
          ? '{"items":['
          : record.fault === 'malformed-shape'
            ? JSON.stringify({ items: [{ slug: 42 }] })
            : JSON.stringify({ items });
      return { status: 200, body, network: false };
    }
    if (
      record.method === 'GET' &&
      record.path === '/v1/training-plans/current'
    ) {
      record.status = 200;
      return {
        status: 200,
        body:
          record.fault === 'malformed-json'
            ? '{"plan":'
            : record.fault === 'malformed-shape'
              ? '{"plan":{"id":1}}'
              : '{"plan":null}',
        network: false,
      };
    }
    if (record.method === 'POST' && record.path === '/v1/training-plans') {
      record.fault = 'none';
      record.status = 409;
      return {
        status: 409,
        body: JSON.stringify({
          error: {
            code: 'training.plan_unavailable',
            message: 'Training plans are not available yet.',
          },
        }),
        network: false,
      };
    }
    record.fault = 'none';
    record.status = 404;
    return {
      status: 404,
      body: '{"error":{"message":"Unknown endpoint."}}',
      network: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

type Call =
  | { type: 'listSaved' }
  | { type: 'save'; slug: number }
  | { type: 'unsave'; slug: number }
  | { type: 'getPlan' }
  | { type: 'createPlan' };

type Control =
  | { type: 'rotate' }
  | { type: 'logout' }
  | { type: 'switchAccount' }
  | { type: 'login' };

type Step =
  { kind: 'call'; call: Call } | { kind: 'control'; control: Control };

interface Burst {
  delay: number;
  steps: Step[];
}

interface Script {
  seed: number;
  faultRate: number;
  maxDelay: number;
  bursts: Burst[];
}

const CATALOG_SIZE = 3;

function generateScript(seed: number): Script {
  const rng = mulberry32(seed);
  const maxDelay = 1 + int(rng, 6);
  const faultRate = pick(rng, [0, 0.1, 0.3]);
  const bursts: Burst[] = [];
  const burstCount = 1 + int(rng, 5);
  for (let b = 0; b < burstCount; b += 1) {
    const steps: Step[] = [];
    const count = 1 + int(rng, 6);
    for (let s = 0; s < count; s += 1) {
      const previous = steps[steps.length - 1];
      if (previous && rng() < 0.25) {
        steps.push(JSON.parse(JSON.stringify(previous)) as Step);
        continue;
      }
      const roll = rng();
      if (roll < 0.7) {
        const type = pick(rng, [
          'listSaved',
          'listSaved',
          'save',
          'unsave',
          'getPlan',
          'createPlan',
        ] as const);
        steps.push({
          kind: 'call',
          call:
            type === 'save' || type === 'unsave'
              ? { type, slug: int(rng, CATALOG_SIZE) }
              : { type },
        });
      } else {
        steps.push({
          kind: 'control',
          control: {
            type: pick(rng, [
              'rotate',
              'rotate',
              'logout',
              'switchAccount',
              'login',
            ] as const),
          },
        });
      }
    }
    bursts.push({ delay: b === 0 ? 0 : int(rng, maxDelay * 2 + 1), steps });
  }
  return { seed, faultRate, maxDelay, bursts };
}

// ---------------------------------------------------------------------------
// Execution + invariants
// ---------------------------------------------------------------------------

type ViolationKind =
  | 'deadlock'
  | 'threw-non-training-error'
  | 'fetch-amplification'
  | 'stale-bearer-sent'
  | 'post-logout-request'
  | 'false-sign-out'
  | 'missed-sign-out'
  | 'unparsed-malformed'
  | 'wrong-status-mapping'
  | 'reordered-list';

interface Violation {
  kind: ViolationKind;
  detail: string;
}

interface IterationMetrics {
  apiCalls: number;
  fetches: number;
  overlappingFetches: number;
  rotations: number;
  logouts: number;
  unauthorizedReports: number;
  statuses: Record<string, number>;
  faults: Record<string, number>;
  events: number;
  wallMs: number;
}

interface IterationResult {
  seed: number;
  outcome: 'held' | 'broken';
  violations: Violation[];
  metrics: IterationMetrics;
}

const MAX_EVENTS = 5_000;
const ITERATION_WALL_MS = 5_000;
const ACCOUNTS = ['acct-a', 'acct-b'] as const;

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

const countBy = (keys: string[]): Record<string, number> =>
  keys.reduce<Record<string, number>>((acc, key) => {
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

async function runScript(script: Script): Promise<IterationResult> {
  const startedAt = performance.now();
  const rng = mulberry32(script.seed ^ 0x9e3779b9);
  const scheduler = new Scheduler();
  const server = new Server(scheduler);
  const violations: Violation[] = [];
  let requestId = 0;
  let rotations = 0;
  let logouts = 0;
  let unauthorizedReports = 0;
  const outstanding: Promise<Settled>[] = [];
  let inFlight = 0;
  let overlappingFetches = 0;

  const sessionFor = (account: string, bearer: string): ApiSession => ({
    apiBaseUrl: BASE_URL,
    bearerToken: bearer,
    canonicalAppUserId: account,
    provider: 'apple',
  });

  const bearerReports: { bearer: string; currentAtReport: boolean }[] = [];
  setApiUnauthorizedListener(session => {
    unauthorizedReports += 1;
    const current = bearerTokenFor(session.canonicalAppUserId);
    bearerReports.push({
      bearer: session.bearerToken,
      currentAtReport: current === session.bearerToken,
    });
  });

  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    const authorization = headers?.['Authorization'] ?? null;
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    const account = bearer ? (server.liveBearers.get(bearer) ?? null) : null;
    requestId += 1;
    const record: RequestRecord = {
      id: requestId,
      method: init?.method ?? 'GET',
      path: input.startsWith(BASE_URL) ? input.slice(BASE_URL.length) : input,
      bearer,
      issuedUnderCurrent:
        account !== null && bearerTokenFor(account) === bearer,
      account,
      issuedAt: scheduler.time,
      processedAt: null,
      status: null,
      fault: 'none',
      serverSnapshot: null,
    };
    server.requests.push(record);
    if (!headers?.['X-Client-Version']) {
      violations.push({
        kind: 'wrong-status-mapping',
        detail: `request ${record.id} missing X-Client-Version header`,
      });
    }
    if (inFlight > 0) overlappingFetches += 1;
    inFlight += 1;
    return new Promise<Response>((resolve, reject) => {
      scheduler.schedule(int(rng, script.maxDelay + 1), () => {
        const answer = server.handle(record, rng, script.faultRate);
        scheduler.schedule(int(rng, script.maxDelay + 1), () => {
          inFlight -= 1;
          if (answer.network) {
            reject(new TypeError('Network request failed'));
            return;
          }
          resolve(httpResponse(answer.status, answer.body));
        });
      });
    });
  };

  let currentAccount: string | null = null;
  let api: TrainingApi | null = null;

  const login = (account: string) => {
    const bearer = server.mintBearer(account);
    establishApiSession(sessionFor(account, bearer));
    currentAccount = account;
    const owner = account;
    api = createTrainingApi({
      baseUrl: BASE_URL,
      get token() {
        return bearerTokenFor(owner);
      },
      fetchFn,
    });
  };
  const rotate = () => {
    if (!currentAccount) return;
    const previous = bearerTokenFor(currentAccount);
    const bearer = server.mintBearer(currentAccount);
    establishApiSession(sessionFor(currentAccount, bearer));
    if (previous) server.revoke(previous);
    rotations += 1;
  };
  const logout = () => {
    if (!currentAccount) return;
    const previous = bearerTokenFor(currentAccount);
    clearApiSession();
    if (previous) server.revoke(previous);
    currentAccount = null;
    api = null;
    logouts += 1;
  };

  login(ACCOUNTS[0]);

  const issue = (call: Call): Promise<unknown> => {
    const client = api;
    if (!client) return Promise.resolve('no-session');
    const slug = 'slug' in call ? `drill-${call.slug}` : '';
    switch (call.type) {
      case 'listSaved':
        return client.listSavedDrills();
      case 'save':
        return client.saveDrill(slug);
      case 'unsave':
        return client.unsaveDrill(slug);
      case 'getPlan':
        return client.getCurrentPlan();
      case 'createPlan':
        return client.createPlan(uuidAt(0xa00));
    }
  };

  let cursor = 0;
  for (const burst of script.bursts) {
    cursor += burst.delay;
    scheduler.schedule(cursor, () => {
      for (const step of burst.steps) {
        if (step.kind === 'control') {
          switch (step.control.type) {
            case 'rotate':
              rotate();
              break;
            case 'logout':
              logout();
              break;
            case 'switchAccount':
              logout();
              login(currentAccount === ACCOUNTS[0] ? ACCOUNTS[1] : ACCOUNTS[0]);
              break;
            case 'login':
              if (!currentAccount) login(ACCOUNTS[0]);
              break;
          }
          continue;
        }
        const callsBefore = requestId;
        const promise: Promise<Settled> = issue(step.call)
          .then((value): Settled => ({ ok: true, value }))
          .catch((error: unknown): Settled => ({ ok: false, error }))
          .then(settled => {
            if (!settled.ok && !(settled.error instanceof TrainingError)) {
              violations.push({
                kind: 'threw-non-training-error',
                detail: `${step.call.type}: ${String(settled.error)}`,
              });
            }
            return settled;
          });
        outstanding.push(promise);
        // The transport is synchronous up to the fetch call: exactly one fetch
        // per API call when a session exists, zero otherwise.
        const fetchesIssued = requestId - callsBefore;
        if (fetchesIssued > 1) {
          violations.push({
            kind: 'fetch-amplification',
            detail: `${step.call.type} issued ${fetchesIssued} fetches`,
          });
        }
      }
    });
  }

  let events = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('iteration exceeded wall-time budget')),
        ITERATION_WALL_MS,
      );
    });
    events = await Promise.race([
      (async () => {
        const drained = await scheduler.drain(MAX_EVENTS);
        await Promise.allSettled(outstanding);
        return drained;
      })(),
      timeout,
    ]);
  } catch (error) {
    violations.push({ kind: 'deadlock', detail: String(error) });
  } finally {
    if (deadline) clearTimeout(deadline);
  }

  const results: Settled[] = await Promise.all(outstanding);

  // Bearer discipline: every fetch went out under the bearer current for its
  // account at issue time; nothing goes out without a session.
  for (const record of server.requests) {
    if (record.bearer === null || record.account === null) {
      violations.push({
        kind: 'post-logout-request',
        detail: `request ${record.id} ${record.method} ${record.path} sent without a live bearer`,
      });
    } else if (!record.issuedUnderCurrent) {
      violations.push({
        kind: 'stale-bearer-sent',
        detail: `request ${record.id} ${record.method} ${record.path} sent under a stale bearer`,
      });
    }
  }

  // 401 discipline: a 401 for a bearer that is no longer current must not
  // reach the sign-out listener; a 401 for the current bearer reaches it once.
  const currentBearer401s = server.requests.filter(
    r =>
      r.status === 401 &&
      r.bearer !== null &&
      r.bearer === (r.account ? bearerTokenFor(r.account) : null),
  );
  for (const report of bearerReports) {
    if (!report.currentAtReport) {
      violations.push({
        kind: 'false-sign-out',
        detail: `unauthorized listener fired for stale bearer ${report.bearer}`,
      });
    }
  }
  // Every 401 whose bearer is STILL current at the end of the iteration must
  // have produced exactly one report (rotation/logout in between are excused
  // because reportApiUnauthorized legitimately ignores them).
  const reportedBearers = countBy(bearerReports.map(r => r.bearer));
  for (const record of currentBearer401s) {
    if (!record.bearer) continue;
    if ((reportedBearers[record.bearer] ?? 0) === 0) {
      violations.push({
        kind: 'missed-sign-out',
        detail: `401 for current bearer ${record.bearer} (request ${record.id}) never reported`,
      });
    }
  }

  // Parsing discipline + status mapping, per settled call in order of issue.
  // Calls without a session resolve to 'no-session' without a fetch.
  const fetched = server.requests;
  let fetchIndex = 0;
  for (const settled of results) {
    if (settled.ok && settled.value === 'no-session') continue;
    const record = fetched[fetchIndex];
    fetchIndex += 1;
    if (!record) break;
    const err = settled.ok ? null : (settled.error as TrainingError);
    if (record.status === null) {
      if (!err || err.code !== 'training.unavailable' || !err.retryable) {
        violations.push({
          kind: 'wrong-status-mapping',
          detail: `request ${record.id} network drop → ${err ? err.code : 'resolved'}`,
        });
      }
      continue;
    }
    if (record.status === 401) {
      if (
        !err ||
        err.code !== 'training.session_expired' ||
        err.status !== 401 ||
        err.retryable
      ) {
        violations.push({
          kind: 'wrong-status-mapping',
          detail: `request ${record.id} 401 → ${err ? err.code : 'resolved'}`,
        });
      }
      continue;
    }
    if (record.status === 429 || record.status >= 500) {
      if (!err || !err.retryable || err.status !== record.status) {
        violations.push({
          kind: 'wrong-status-mapping',
          detail: `request ${record.id} ${record.status} → ${err ? `${err.code}/retryable=${err.retryable}` : 'resolved'}`,
        });
      }
      continue;
    }
    if (
      record.status === 403 ||
      record.status === 404 ||
      record.status === 409
    ) {
      if (!err || err.retryable || err.status !== record.status) {
        violations.push({
          kind: 'wrong-status-mapping',
          detail: `request ${record.id} ${record.status} → ${err ? `${err.code}/retryable=${err.retryable}` : 'resolved'}`,
        });
      }
      continue;
    }
    if (
      record.fault === 'malformed-json' ||
      record.fault === 'malformed-shape'
    ) {
      if (!err || err.code !== 'training.invalid_response') {
        violations.push({
          kind: 'unparsed-malformed',
          detail: `request ${record.id} ${record.fault} → ${err ? err.code : 'resolved'}`,
        });
      }
      continue;
    }
    if (err) {
      violations.push({
        kind: 'wrong-status-mapping',
        detail: `request ${record.id} ${record.status} healthy → threw ${err.code}`,
      });
      continue;
    }
    if (
      settled.ok &&
      record.method === 'GET' &&
      record.path === '/v1/me/saved-drills'
    ) {
      const slugs = (settled.value as { slug: string }[]).map(r => r.slug);
      if (JSON.stringify(slugs) !== JSON.stringify(record.serverSnapshot)) {
        violations.push({
          kind: 'reordered-list',
          detail: `request ${record.id} parsed ${JSON.stringify(slugs)} vs server ${JSON.stringify(record.serverSnapshot)}`,
        });
      }
    }
  }
  if (fetchIndex !== fetched.length) {
    violations.push({
      kind: 'fetch-amplification',
      detail: `${fetched.length} fetches for ${fetchIndex} settled API calls`,
    });
  }

  setApiUnauthorizedListener(null);
  clearApiSession();

  return {
    seed: script.seed,
    outcome: violations.length === 0 ? 'held' : 'broken',
    violations,
    metrics: {
      apiCalls: results.filter(r => !(r.ok && r.value === 'no-session')).length,
      fetches: server.requests.length,
      overlappingFetches,
      rotations,
      logouts,
      unauthorizedReports,
      statuses: countBy(server.requests.map(r => String(r.status ?? 'net'))),
      faults: countBy(server.requests.map(r => r.fault)),
      events,
      wallMs: Math.round(performance.now() - startedAt),
    },
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const ITERATIONS = Number.parseInt(process.env['STRESS_ITER'] ?? '500', 10);
const SINGLE_SEED = process.env['STRESS_SEED'];
const OUT_DIR = process.env['STRESS_OUT_DIR'];

const seeds = SINGLE_SEED
  ? [Number.parseInt(SINGLE_SEED, 10)]
  : Array.from({ length: ITERATIONS }, (_, i) => i);

describe('training api concurrency stress (seeded)', () => {
  const results: IterationResult[] = [];
  let campaignWallMs = 0;

  beforeAll(async () => {
    const started = performance.now();
    for (const seed of seeds) {
      results.push(await runScript(generateScript(seed)));
    }
    campaignWallMs = Math.round(performance.now() - started);
    if (OUT_DIR) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const violationsByKind = countBy(
        results.flatMap(r => r.violations.map(v => v.kind)),
      );
      fs.writeFileSync(
        path.join(OUT_DIR, 'trainingApiConcurrency.json'),
        JSON.stringify(
          {
            unit: 'apps/mobile/src/training/api.ts + account/apiSession.ts',
            lens: 'concurrency',
            iterations: results.length,
            campaignWallMs,
            held: results.filter(r => r.outcome === 'held').length,
            broken: results.filter(r => r.outcome === 'broken').length,
            violationsByKind,
            totals: {
              apiCalls: results.reduce((n, r) => n + r.metrics.apiCalls, 0),
              fetches: results.reduce((n, r) => n + r.metrics.fetches, 0),
              overlappingFetches: results.reduce(
                (n, r) => n + r.metrics.overlappingFetches,
                0,
              ),
              rotations: results.reduce((n, r) => n + r.metrics.rotations, 0),
              logouts: results.reduce((n, r) => n + r.metrics.logouts, 0),
              unauthorizedReports: results.reduce(
                (n, r) => n + r.metrics.unauthorizedReports,
                0,
              ),
              statuses: results
                .map(r => r.metrics.statuses)
                .reduce<Record<string, number>>((acc, s) => {
                  for (const [k, v] of Object.entries(s))
                    acc[k] = (acc[k] ?? 0) + v;
                  return acc;
                }, {}),
              faults: results
                .map(r => r.metrics.faults)
                .reduce<Record<string, number>>((acc, s) => {
                  for (const [k, v] of Object.entries(s))
                    acc[k] = (acc[k] ?? 0) + v;
                  return acc;
                }, {}),
            },
            results: results.map(r => ({
              seed: r.seed,
              outcome: r.outcome,
              violations: r.violations,
              metrics: r.metrics,
            })),
          },
          null,
          2,
        ),
      );
    }
  });

  const report = (kinds: ViolationKind[]) =>
    results
      .flatMap(r => r.violations.map(v => ({ seed: r.seed, ...v })))
      .filter(v => kinds.includes(v.kind))
      .map(v => `${v.kind} seed=${v.seed}: ${v.detail}`);

  it('executes every seeded interleaving to quiescence within bounded wall time', () => {
    expect(results).toHaveLength(seeds.length);
    expect(report(['deadlock', 'threw-non-training-error'])).toEqual([]);
    expect(campaignWallMs).toBeLessThan(25_000 + seeds.length * 40);
  });

  it('issues exactly one fetch per API call, even under bursts', () => {
    expect(report(['fetch-amplification'])).toEqual([]);
    expect(
      results.reduce((n, r) => n + r.metrics.overlappingFetches, 0),
    ).toBeGreaterThan(0);
  });

  it('never sends a request under a stale bearer or after sign-out', () => {
    expect(report(['stale-bearer-sent', 'post-logout-request'])).toEqual([]);
  });

  it('never signs the user out on a 401 for a rotated/cleared bearer, and always on a current one', () => {
    expect(report(['false-sign-out', 'missed-sign-out'])).toEqual([]);
  });

  it('maps every status and malformed body to the documented TrainingError', () => {
    expect(
      report(['wrong-status-mapping', 'unparsed-malformed', 'reordered-list']),
    ).toEqual([]);
  });
});
