/**
 * Evidence writer for the Live Court adversarial harness: JSON tables, logs
 * and heap measurements under `artifacts/live-court-adversarial/<run>/`
 * (repo root; `artifacts/` is gitignored). Heap snapshots (`.heapsnapshot`)
 * are written only when LIVE_COURT_HEAP_SNAPSHOTS=1 — they are large.
 */
declare const __dirname: string;
declare const require: (id: string) => unknown;

interface Fs {
  mkdirSync(dir: string, options: { recursive: boolean }): void;
  appendFileSync(file: string, data: string): void;
  writeFileSync(file: string, data: string): void;
  statSync(file: string): { size: number };
}
interface Path {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
}
interface V8 {
  writeHeapSnapshot(file: string): string;
}

const fs = require('fs') as Fs;
const path = require('path') as Path;
const v8 = require('v8') as V8;

declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  hrtime: { bigint(): bigint };
};

declare const global: { gc?: () => void };

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

export const RUN_ID =
  process.env.LIVE_COURT_HARNESS_RUN ??
  new Date().toISOString().replace(/[:.]/g, '-');

export const ARTIFACT_DIR = path.join(
  REPO_ROOT,
  'artifacts',
  'live-court-adversarial',
  RUN_ID,
);

export interface HeapSample {
  label: string;
  gcForced: boolean;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 1000) / 1000;

export function heapSample(label: string): HeapSample {
  const gcForced = typeof global.gc === 'function';
  if (gcForced) {
    global.gc?.();
    global.gc?.();
  }
  const usage = process.memoryUsage();
  return {
    label,
    gcForced,
    rssMb: toMb(usage.rss),
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers),
  };
}

export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export class Evidence {
  readonly dir: string;
  private readonly logLines: string[] = [];

  constructor(public readonly scenario: string) {
    this.dir = path.join(ARTIFACT_DIR, scenario);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  log(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}`;
    this.logLines.push(stamped);
    fs.appendFileSync(path.join(this.dir, 'run.log'), `${stamped}\n`);
  }

  writeJson(name: string, data: unknown): string {
    const file = path.join(
      this.dir,
      name.endsWith('.json') ? name : `${name}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(data, jsonSafe, 2));
    return file;
  }

  /** Writes a V8 heap snapshot when enabled; returns the path or null. */
  heapSnapshot(name: string): string | null {
    if (process.env.LIVE_COURT_HEAP_SNAPSHOTS !== '1') return null;
    const file = path.join(this.dir, `${name}.heapsnapshot`);
    const written = v8.writeHeapSnapshot(file);
    this.log(
      `heap snapshot written: ${written} (${toMb(fs.statSync(written).size)} MB)`,
    );
    return written;
  }

  relative(file: string): string {
    return path.relative(REPO_ROOT, file);
  }
}

function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value))
    return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

/** Least-squares fit y = slope·x + intercept (for scaling tables). */
export function linearFit(
  points: ReadonlyArray<{ x: number; y: number }>,
): LinearFit {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0, r2: 1 };
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
    syy += (p.y - meanY) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}
