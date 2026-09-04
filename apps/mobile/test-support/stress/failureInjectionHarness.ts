import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TrainingFetch } from '../../src/training/api';

/**
 * Shared machinery for the `failure-injection` stress campaigns against the
 * training module (`src/training/api.ts` + `src/training/store.ts`).
 *
 * The unit's only I/O dependency is the injected `fetchFn`; everything the
 * server can do wrong is modelled as a `FaultKind` applied to ONE route
 * (`RouteKind`) while every other route answers healthily. The generator is
 * seeded (mulberry32), so any iteration is replayable from its seed alone:
 *
 *   STRESS_SEEDS=<seed>[,<seed>…] npx jest --ci __tests__/stress/<suite>
 *
 * Campaign size is `STRESS_ITER` (small default so the suite stays in the
 * normal Jest run); the JSON seed → outcome table lands at `STRESS_OUT`.
 */

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  between(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
}

export function rngFor(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number) =>
    maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive) % maxExclusive;
  return {
    next,
    int,
    between: (min, max) => min + int(max - min + 1),
    pick: items => items[int(items.length)]!,
    bool: (probability = 0.5) => next() < probability,
  };
}

export function iterationCount(fallback: number): number {
  const raw = process.env['STRESS_ITER'];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function replaySeeds(): number[] | null {
  const raw = process.env['STRESS_SEEDS'];
  if (!raw) return null;
  const seeds = raw
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(seed => Number.isFinite(seed));
  return seeds.length > 0 ? seeds : null;
}

export function seedsFor(base: number, count: number): number[] {
  const replay = replaySeeds();
  if (replay) return replay;
  return Array.from({ length: count }, (_, index) => base + index);
}

// ─── Sentinels ───────────────────────────────────────────────────────────────

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

export interface RejectionSentinel {
  drain(): string[];
  restore(): void;
}

/** A `void promise` that rejects is a silent failure; the sentinel sees it. */
export function installRejectionSentinel(): RejectionSentinel {
  const rejections: string[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(describeReason(reason));
  };
  process.on('unhandledRejection', onRejection);
  return {
    drain: () => rejections.splice(0, rejections.length),
    restore: () => {
      process.off('unhandledRejection', onRejection);
    },
  };
}

export interface ConsoleSentinel {
  drain(): string[];
  restore(): void;
}

export function installConsoleSentinel(): ConsoleSentinel {
  const messages: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    messages.push(args.map(describeReason).join(' '));
  };
  console.error = capture as typeof console.error;
  console.warn = capture as typeof console.warn;
  return {
    drain: () => messages.splice(0, messages.length),
    restore: () => {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

// ─── Result table ────────────────────────────────────────────────────────────

export interface IterationRecord {
  seed: number;
  scenario: string;
  outcome: 'HELD' | 'BROKEN';
  /** Injected faults + assertions actually exercised in this iteration. */
  interactions: number;
  script: string;
  failures: string[];
}

export interface ResultTable {
  unit: string;
  lens: string;
  baseSeed: number;
  iterations: number;
  interactions: number;
  broken: number;
  scenarioCounts: Record<string, number>;
  faultCounts: Record<string, number>;
  generatedAtIso: string;
  results: IterationRecord[];
}

export function buildResultTable(input: {
  unit: string;
  lens: string;
  baseSeed: number;
  results: IterationRecord[];
  faultOf: (record: IterationRecord) => string;
}): ResultTable {
  const scenarioCounts: Record<string, number> = {};
  const faultCounts: Record<string, number> = {};
  for (const record of input.results) {
    scenarioCounts[record.scenario] =
      (scenarioCounts[record.scenario] ?? 0) + 1;
    const fault = input.faultOf(record);
    faultCounts[fault] = (faultCounts[fault] ?? 0) + 1;
  }
  return {
    unit: input.unit,
    lens: input.lens,
    baseSeed: input.baseSeed,
    iterations: input.results.length,
    interactions: input.results.reduce(
      (total, record) => total + record.interactions,
      0,
    ),
    broken: input.results.filter(record => record.outcome === 'BROKEN').length,
    scenarioCounts,
    faultCounts,
    generatedAtIso: new Date().toISOString(),
    results: input.results,
  };
}

export function writeResultTable(name: string, table: ResultTable): string {
  const target =
    process.env['STRESS_OUT'] ??
    path.join(os.tmpdir(), 'pickle-stress', `${name}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(table, null, 2)}\n`);
  return target;
}

// ─── Training server model ───────────────────────────────────────────────────

export const ROUTE_KINDS = [
  'saved-list',
  'detail',
  'plan-current',
  'plan-create',
  'plan-reassess',
  'save',
  'unsave',
  'complete',
  'catalog',
] as const;

export type RouteKind = (typeof ROUTE_KINDS)[number];

export function classifyRoute(method: string, url: string): RouteKind {
  const pathname = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
  if (pathname === '/v1/me/saved-drills') return 'saved-list';
  if (pathname.startsWith('/v1/me/saved-drills/')) {
    return method === 'DELETE' ? 'unsave' : 'save';
  }
  if (pathname === '/v1/catalog/drills') return 'catalog';
  if (pathname.startsWith('/v1/catalog/drills/')) return 'detail';
  if (pathname === '/v1/training-plans/current') return 'plan-current';
  if (pathname === '/v1/training-plans') return 'plan-create';
  if (/^\/v1\/training-plans\/[^/]+\/reassessment$/.test(pathname)) {
    return 'plan-reassess';
  }
  if (pathname === '/v1/drill-completions') return 'complete';
  throw new Error(`unrouted training request ${method} ${url}`);
}

export const FAULT_KINDS = [
  /** fetchFn throws synchronously (a broken polyfill / bridge). */
  'throw-sync',
  /** fetch rejects immediately (offline, DNS, TLS). */
  'reject-network',
  /** fetch rejects with AbortError after a delay (platform timeout). */
  'reject-timeout',
  /** response arrives, but only after 5–55 s. */
  'slow',
  /** the promise never settles. */
  'never-resolves',
  /** 401 — bearer refused. */
  'http-401',
  /** 429 with a JSON error envelope. */
  'http-429',
  /** 5xx with a JSON error envelope. */
  'http-5xx',
  /** 5xx whose body is HTML, not JSON. */
  'http-5xx-html',
  /** 4xx (403/404/409/422) with a JSON error envelope. */
  'http-4xx',
  /** 4xx whose error envelope is not the documented shape. */
  'http-4xx-bare',
  /** 200 whose body is not JSON. */
  'malformed-json',
  /** 200 whose JSON violates the documented contract in one field. */
  'malformed-payload',
  /** 200 with an empty object / wrong top-level shape. */
  'wrong-shape',
  /** 204 where a JSON body is required. */
  'empty-204',
  /** 200 that echoes a different resource than requested. */
  'wrong-echo',
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export interface Fault {
  kind: FaultKind;
  /** Extra detail for replay (status code, delay, mutation name). */
  detail: string;
  /** Delay before the fault resolves/rejects (slow / reject-timeout). */
  delayMs: number;
}

export function pickFault(rng: Rng, allowed: readonly FaultKind[]): Fault {
  const kind = rng.pick(allowed);
  switch (kind) {
    case 'slow':
      return { kind, detail: 'ok', delayMs: rng.between(5, 55) * 1000 };
    case 'reject-timeout':
      return { kind, detail: 'AbortError', delayMs: rng.between(1, 59) * 1000 };
    case 'http-5xx':
    case 'http-5xx-html':
      return {
        kind,
        detail: String(rng.pick([500, 502, 503, 504])),
        delayMs: 0,
      };
    case 'http-4xx':
    case 'http-4xx-bare':
      return {
        kind,
        detail: String(rng.pick([400, 403, 404, 409, 422])),
        delayMs: 0,
      };
    default:
      return { kind, detail: '', delayMs: 0 };
  }
}

/** Faults after which the same request is expected to succeed on retry. */
export function isRetryableFault(fault: Fault): boolean {
  switch (fault.kind) {
    case 'throw-sync':
    case 'reject-network':
    case 'reject-timeout':
    case 'http-429':
    case 'http-5xx':
    case 'http-5xx-html':
    case 'malformed-json':
    case 'malformed-payload':
    case 'wrong-shape':
    case 'empty-204':
    case 'wrong-echo':
      return true;
    case 'http-401':
    case 'http-4xx':
    case 'http-4xx-bare':
    case 'slow':
    case 'never-resolves':
      return false;
  }
}

/** Error code the training client is documented to surface for a fault. */
export function expectedErrorCode(fault: Fault): string {
  switch (fault.kind) {
    case 'throw-sync':
    case 'reject-network':
    case 'reject-timeout':
      return 'training.unavailable';
    case 'http-401':
      return 'training.session_expired';
    case 'http-429':
    case 'http-5xx':
    case 'http-4xx':
      return `server.${fault.detail || '429'}`;
    case 'http-5xx-html':
      return 'training.invalid_response';
    case 'http-4xx-bare':
      return 'training.request_failed';
    case 'malformed-json':
    case 'malformed-payload':
    case 'wrong-shape':
    case 'empty-204':
    case 'wrong-echo':
      return 'training.invalid_response';
    case 'slow':
    case 'never-resolves':
      return '';
  }
}

export function makeResponse(
  status: number,
  body: unknown,
  options: { jsonThrows?: boolean } = {},
): Response {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (options.jsonThrows) {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      }
      return body;
    },
  };
  return response as unknown as Response;
}

export const NEVER = new Promise<Response>(() => undefined);

export interface RequestLogEntry {
  method: string;
  route: RouteKind;
  url: string;
  body: unknown;
  faulted: boolean;
}

export interface InjectedServer {
  fetchFn: TrainingFetch;
  log: RequestLogEntry[];
  /**
   * Replace the fault plan (e.g. heal everything before a retry). `maxHits`
   * bounds how many matching requests are faulted (default: every one).
   */
  setFault(
    target: RouteKind | null,
    fault: Fault | null,
    maxHits?: number,
  ): void;
  /** Number of faulted requests actually served. */
  faultsServed(): number;
}

export interface ServerModel {
  healthy(route: RouteKind, url: string, body: unknown): Response;
  /** A 200 body that violates the route's contract in exactly one field. */
  malformed(
    route: RouteKind,
    url: string,
    rng: Rng,
  ): { body: unknown; mutation: string };
  /** A 200 body for a DIFFERENT resource than the one requested. */
  wrongEcho(route: RouteKind, url: string): unknown;
}

function errorEnvelope(status: number) {
  return {
    error: {
      code: `server.${status}`,
      message: `Injected ${status} from the training server.`,
    },
  };
}

/**
 * Builds the injected fetch. `target`+`fault` apply to matching requests
 * (every occurrence, or only the first `maxHits` if given); other routes
 * answer healthily. Timer-based faults use the ambient (fake) timers.
 */
export function createInjectedServer(
  model: ServerModel,
  rng: Rng,
  initial: { target: RouteKind | null; fault: Fault | null; maxHits?: number },
): InjectedServer {
  let target = initial.target;
  let fault = initial.fault;
  let hits = 0;
  let maxHits = initial.maxHits ?? Number.POSITIVE_INFINITY;
  const log: RequestLogEntry[] = [];

  const serveFault = (
    active: Fault,
    route: RouteKind,
    url: string,
    body: unknown,
  ): Promise<Response> | Response => {
    switch (active.kind) {
      case 'throw-sync':
        throw new TypeError('fetch is not a function (injected)');
      case 'reject-network':
        return Promise.reject(new TypeError('Network request failed'));
      case 'reject-timeout':
        return new Promise<Response>((_, reject) => {
          setTimeout(() => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          }, active.delayMs);
        });
      case 'slow':
        return new Promise<Response>(resolve => {
          setTimeout(
            () => resolve(model.healthy(route, url, body)),
            active.delayMs,
          );
        });
      case 'never-resolves':
        return NEVER;
      case 'http-401':
        return makeResponse(401, errorEnvelope(401));
      case 'http-429':
        return makeResponse(429, errorEnvelope(429));
      case 'http-5xx':
      case 'http-4xx':
        return makeResponse(
          Number(active.detail),
          errorEnvelope(Number(active.detail)),
        );
      case 'http-5xx-html':
        return makeResponse(Number(active.detail), null, { jsonThrows: true });
      case 'http-4xx-bare':
        return makeResponse(Number(active.detail), {
          message: 'nope',
          code: 7,
        });
      case 'malformed-json':
        return makeResponse(200, null, { jsonThrows: true });
      case 'malformed-payload':
        return makeResponse(200, model.malformed(route, url, rng).body);
      case 'wrong-shape':
        return makeResponse(
          200,
          rng.pick([{}, [], 'ok', 42, null, { items: 'x' }, { plan: 1 }]),
        );
      case 'empty-204':
        return makeResponse(204, null);
      case 'wrong-echo':
        return makeResponse(200, model.wrongEcho(route, url));
    }
  };

  const fetchFn: TrainingFetch = (input, init) => {
    const method = init?.method ?? 'GET';
    const route = classifyRoute(method, input);
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const faulted = fault !== null && target === route && hits < maxHits;
    log.push({ method, route, url: input, body, faulted });
    if (faulted && fault) {
      hits += 1;
      const served = serveFault(fault, route, input, body);
      return served instanceof Promise ? served : Promise.resolve(served);
    }
    return Promise.resolve(model.healthy(route, input, body));
  };

  return {
    fetchFn,
    log,
    setFault: (nextTarget, nextFault, nextMaxHits) => {
      target = nextTarget;
      fault = nextFault;
      maxHits = nextMaxHits ?? Number.POSITIVE_INFINITY;
      hits = 0;
    },
    faultsServed: () => log.filter(entry => entry.faulted).length,
  };
}
