/**
 * Process-level leak probe for long-run stress campaigns.
 *
 * Installed BEFORE any application module loads (import it first) so the
 * scheduler / React / RN copies that capture `setTimeout` & co. at module
 * scope get the counting wrappers. Nothing here changes behaviour: every
 * wrapper forwards to the original global and only bookkeeps outstanding
 * timers so a campaign can assert they return to baseline.
 *
 * apps/mobile has no @types/node, so the Node process surface this probe
 * reads is declared locally and accessed through `globalThis`.
 */

type TimerHandle = unknown;

interface ProcessProbeSurface {
  memoryUsage(): { heapUsed: number; heapTotal: number; rss: number };
  hrtime: { bigint(): bigint };
  getActiveResourcesInfo?: () => string[];
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
}

const proc = (globalThis as unknown as { process: ProcessProbeSurface })
  .process;
const gcFn = (globalThis as unknown as { gc?: () => void }).gc;

export const gcExposed = typeof gcFn === 'function';

const outstandingTimeouts = new Set<TimerHandle>();
const outstandingIntervals = new Set<TimerHandle>();
const outstandingImmediates = new Set<TimerHandle>();

export interface TimerDetail {
  kind: 'timeout' | 'interval';
  delayMs: number;
  stack: string;
}
const details = new Map<TimerHandle, TimerDetail>();

let installed = false;
let captureStacks = false;

function stackOf(): string {
  return (new Error().stack ?? '')
    .split('\n')
    .slice(3, 12)
    .map(l => l.trim())
    .join(' <- ');
}

/**
 * @param options.captureStacks record delay + creation stack of every timer
 *   (slower; use when diagnosing which code left a timer behind).
 */
export function installTimerProbe(options?: { captureStacks?: boolean }): void {
  if (installed) return;
  installed = true;
  captureStacks = options?.captureStacks ?? false;
  const g = globalThis as unknown as Record<string, unknown>;
  const origSetTimeout = g.setTimeout as (...a: unknown[]) => TimerHandle;
  const origClearTimeout = g.clearTimeout as (h: TimerHandle) => void;
  const origSetInterval = g.setInterval as (...a: unknown[]) => TimerHandle;
  const origClearInterval = g.clearInterval as (h: TimerHandle) => void;
  const origSetImmediate = g.setImmediate as (...a: unknown[]) => TimerHandle;
  const origClearImmediate = g.clearImmediate as (h: TimerHandle) => void;

  g.setTimeout = function probedSetTimeout(
    fn: (...args: unknown[]) => void,
    ...rest: unknown[]
  ) {
    const wrapped = (...args: unknown[]) => {
      outstandingTimeouts.delete(handle);
      details.delete(handle);
      fn(...args);
    };
    const handle = origSetTimeout(wrapped, ...rest);
    outstandingTimeouts.add(handle);
    if (captureStacks) {
      details.set(handle, {
        kind: 'timeout',
        delayMs: Number(rest[0] ?? 0),
        stack: stackOf(),
      });
    }
    return handle;
  };
  g.clearTimeout = function probedClearTimeout(handle: TimerHandle) {
    outstandingTimeouts.delete(handle);
    details.delete(handle);
    return origClearTimeout(handle);
  };
  g.setInterval = function probedSetInterval(...args: unknown[]) {
    const handle = origSetInterval(...args);
    outstandingIntervals.add(handle);
    if (captureStacks) {
      details.set(handle, {
        kind: 'interval',
        delayMs: Number(args[1] ?? 0),
        stack: stackOf(),
      });
    }
    return handle;
  };
  g.clearInterval = function probedClearInterval(handle: TimerHandle) {
    outstandingIntervals.delete(handle);
    details.delete(handle);
    return origClearInterval(handle);
  };
  g.setImmediate = function probedSetImmediate(
    fn: (...args: unknown[]) => void,
    ...rest: unknown[]
  ) {
    const wrapped = (...args: unknown[]) => {
      outstandingImmediates.delete(handle);
      fn(...args);
    };
    const handle = origSetImmediate(wrapped, ...rest);
    outstandingImmediates.add(handle);
    return handle;
  };
  g.clearImmediate = function probedClearImmediate(handle: TimerHandle) {
    outstandingImmediates.delete(handle);
    return origClearImmediate(handle);
  };
}

export interface TimerCounts {
  timeouts: number;
  intervals: number;
  immediates: number;
}

/** Delay + creation stack of every outstanding timer (captureStacks only). */
export function outstandingTimerDetails(): TimerDetail[] {
  const out: TimerDetail[] = [];
  for (const handle of outstandingTimeouts) {
    const d = details.get(handle);
    if (d) out.push(d);
  }
  for (const handle of outstandingIntervals) {
    const d = details.get(handle);
    if (d) out.push(d);
  }
  return out;
}

export function timerCounts(): TimerCounts {
  return {
    timeouts: outstandingTimeouts.size,
    intervals: outstandingIntervals.size,
    immediates: outstandingImmediates.size,
  };
}

export interface HandleSnapshot {
  activeHandles: number;
  activeRequests: number;
  resources: Record<string, number>;
}

export function handleSnapshot(): HandleSnapshot {
  const resources: Record<string, number> = {};
  if (typeof proc.getActiveResourcesInfo === 'function') {
    for (const name of proc.getActiveResourcesInfo()) {
      resources[name] = (resources[name] ?? 0) + 1;
    }
  }
  return {
    activeHandles:
      typeof proc._getActiveHandles === 'function'
        ? proc._getActiveHandles().length
        : -1,
    activeRequests:
      typeof proc._getActiveRequests === 'function'
        ? proc._getActiveRequests().length
        : -1,
    resources,
  };
}

/** Full GC (twice — the first pass can leave finalizable garbage) + heap. */
export function forcedHeapUsed(): number {
  if (gcFn) {
    gcFn();
    gcFn();
  }
  return proc.memoryUsage().heapUsed;
}

export function nowMs(): number {
  return Number(proc.hrtime.bigint()) / 1e6;
}

/** Deterministic 32-bit PRNG (mulberry32) — every iteration replays from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-iteration seed derived from the campaign seed (splitmix-style hash). */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  let x = (campaignSeed ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Least-squares slope of y over x. */
export function linearSlope(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  return den === 0 ? 0 : num / den;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
