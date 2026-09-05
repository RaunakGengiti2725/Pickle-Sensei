/**
 * Shared kit for the `mod-library-focus` failure-injection campaigns.
 *
 * Everything a scenario needs to be replayable from its seed lives here:
 * the seeded RNG, the fault taxonomy, hostile persisted-payload generators,
 * an independent reference implementation of the focus contract (so the
 * campaigns never assert the module against itself), and the JSON report
 * writer that turns one campaign into a seed → outcome table.
 *
 * Nothing in this file touches production code; it is consumed only by the
 * suites under `__tests__/stress/`.
 */
import type {
  LibraryFocus,
  ScoredCheckpointFact,
} from '../../src/library/libraryFocus';

/** Node globals the RN tsconfig does not declare (same pattern as
 * xc/xcMatrixNetworkAuth2.keeper.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

// ─── Seeded randomness ───────────────────────────────────────────────────────

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() needs a non-empty list');
  return items[Math.floor(rng() * items.length)]!;
}

/** Integer in [min, max] inclusive. */
export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

// ─── Campaign knobs ──────────────────────────────────────────────────────────

/** Default iteration count when STRESS_ITER is unset — small enough for the
 * regular suite, still above the ≥60 injected-fault floor across suites. */
export const DEFAULT_ITERATIONS = 72;

export function iterations(envKey = 'STRESS_ITER'): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return DEFAULT_ITERATIONS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${envKey} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

/** `STRESS_SEED=<n>` replays exactly one seed; otherwise seeds are
 * 0..iterations-1 so every campaign row is reproducible by index. */
export function seedList(envKey = 'STRESS_ITER'): number[] {
  const only = process.env.STRESS_SEED;
  if (only !== undefined && only !== '') {
    const seed = Number(only);
    if (!Number.isSafeInteger(seed)) {
      throw new Error(`STRESS_SEED must be an integer, got ${only}`);
    }
    return [seed];
  }
  return Array.from({ length: iterations(envKey) }, (_, i) => i);
}

// ─── Fault taxonomy ──────────────────────────────────────────────────────────

export const FAULT_MODES = [
  'throw',
  'reject',
  'timeout',
  'malformed',
  'partial',
  'slow',
  'never',
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

/** Milliseconds of fake time each campaign advances before it decides a
 * dependency is hung — the lens's "no infinite spinner" bound. */
export const HANG_BUDGET_MS = 60_000;

export interface ScenarioRow {
  seed: number;
  dependency: string;
  fault: FaultMode;
  detail: string;
  outcome: 'HELD' | 'BROKEN';
  /** Invariant ids that failed (empty when HELD). */
  violations: string[];
  /** Known-defect class when the violation is a pinned finding. */
  defect: string | null;
  replay: string;
}

/** Deferred promise whose settlement the scenario controls with fake timers. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Hostile persisted payloads ──────────────────────────────────────────────

export const SHOT_TYPES = [
  'dink',
  'volley',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'return',
  'third_shot_drop',
  'overhead',
] as const;

export const CHECKPOINT_KEYS = [
  'contact_position',
  'athletic_base',
  'paddle_face',
  'contact_height',
  'follow_through',
] as const;

/** A well-formed real scored analysis payload as `local_shot.payload` holds it. */
export interface PayloadShape {
  id: unknown;
  sessionId?: unknown;
  shotType: unknown;
  capturedAtIso: unknown;
  source: unknown;
  resultKind: unknown;
  checkpoints: unknown;
  [extra: string]: unknown;
}

export function isoAt(rng: Rng): string {
  const day = int(rng, 1, 28);
  const hour = int(rng, 0, 23);
  const minute = int(rng, 0, 59);
  return `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(
    2,
    '0',
  )}:${String(minute).padStart(2, '0')}:00.000Z`;
}

export function uuidLike(rng: Rng): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  return `${Array.from({ length: 8 }, hex).join('')}-0000-4000-8000-${Array.from(
    { length: 12 },
    hex,
  ).join('')}`;
}

export function validPayload(rng: Rng): PayloadShape {
  const shotType = pick(rng, SHOT_TYPES);
  const count = int(rng, 1, CHECKPOINT_KEYS.length);
  const keys = [...CHECKPOINT_KEYS].sort(() => rng() - 0.5).slice(0, count);
  return {
    id: uuidLike(rng),
    sessionId: uuidLike(rng),
    shotType,
    capturedAtIso: isoAt(rng),
    source: 'real',
    resultKind: 'scored',
    overallScore: int(rng, 0, 100),
    checkpoints: keys.map(key => ({
      key,
      score: chance(rng, 0.15) ? null : int(rng, 0, 100),
      applicable: chance(rng, 0.9),
    })),
  };
}

/**
 * Corruption classes for one persisted row. Each yields the raw `payload`
 * column value (already stringified where a string is what SQLite holds)
 * plus a label so a failing seed names the class that broke it.
 */
export const MALFORMED_CLASSES = [
  'not-json',
  'json-primitive',
  'json-array',
  'json-null',
  'empty-object',
  'payload-null',
  'payload-missing',
  'payload-number',
  'payload-undefined-string',
  'source-fixture',
  'resultkind-abstained',
  'checkpoints-missing',
  'checkpoints-object',
  'checkpoints-with-null-entry',
  'checkpoints-with-primitive-entry',
  'checkpoint-key-missing',
  'checkpoint-score-string',
  'checkpoint-score-nan-string',
  'checkpoint-score-huge',
  'checkpoint-score-negative',
  'checkpoint-applicable-string',
  'shottype-number',
  'shottype-null',
  'shottype-object',
  'shottype-missing',
  'capturedat-number',
  'capturedat-null',
  'capturedat-object',
  'capturedat-missing',
  'id-number',
  'id-null',
  'id-missing',
] as const;
export type MalformedClass = (typeof MALFORMED_CLASSES)[number];

export interface RawRow {
  /** The row exactly as a driver would hand it back. */
  row: Record<string, unknown>;
  label: string;
  /** The payload the reference policy keeps as evidence-bearing, or null
   * when the reference excludes the row (see `referenceKept`). */
  payload: PayloadShape | null;
}

/**
 * Reference keep/exclude policy for one persisted row, written independently
 * of the repository: keep iff the payload column parses to an object that is
 * a real scored analysis with an array of non-null checkpoint entries. Field
 * TYPES are deliberately not checked here — the campaign's I3 invariant
 * judges those, so a kept-but-ill-typed row is reported as such rather than
 * hidden behind the reference.
 */
export function referenceKept(
  row: Record<string, unknown>,
): PayloadShape | null {
  if (!('payload' in row) || typeof row.payload !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const p = parsed as Record<string, unknown>;
  if (p.source !== 'real' || p.resultKind !== 'scored') return null;
  if (!Array.isArray(p.checkpoints)) return null;
  if (p.checkpoints.some(cp => cp === null || cp === undefined)) return null;
  return p as PayloadShape;
}

export function validRow(rng: Rng): RawRow {
  const payload = validPayload(rng);
  const row = { payload: JSON.stringify(payload) };
  return { row, label: 'valid', payload: referenceKept(row) };
}

export function malformedRow(rng: Rng, cls: MalformedClass): RawRow {
  const base = validPayload(rng);
  const wrap = (payload: unknown): RawRow => {
    const row = { payload: JSON.stringify(payload) };
    return { row, label: cls, payload: referenceKept(row) };
  };
  const first = (base.checkpoints as Record<string, unknown>[])[0];
  const withFirst = (patch: Record<string, unknown>): RawRow => {
    const checkpoints = [...(base.checkpoints as Record<string, unknown>[])];
    checkpoints[0] = { ...first, ...patch };
    return wrap({ ...base, checkpoints });
  };
  switch (cls) {
    case 'not-json':
      return { row: { payload: '{"id": ' }, label: cls, payload: null };
    case 'payload-undefined-string':
      return { row: { payload: 'undefined' }, label: cls, payload: null };
    case 'json-primitive':
      return wrap(42);
    case 'json-array':
      return wrap([base]);
    case 'json-null':
      return wrap(null);
    case 'empty-object':
      return wrap({});
    case 'payload-null':
      return { row: { payload: null }, label: cls, payload: null };
    case 'payload-missing':
      return { row: {}, label: cls, payload: null };
    case 'payload-number':
      return { row: { payload: 7 }, label: cls, payload: null };
    case 'source-fixture':
      return wrap({ ...base, source: 'fixture' });
    case 'resultkind-abstained':
      return wrap({ ...base, resultKind: 'abstained' });
    case 'checkpoints-missing': {
      const { checkpoints: _dropped, ...rest } = base;
      return wrap(rest);
    }
    case 'checkpoints-object':
      return wrap({ ...base, checkpoints: { key: 'contact_position' } });
    case 'checkpoints-with-null-entry':
      return wrap({ ...base, checkpoints: [null, first] });
    case 'checkpoints-with-primitive-entry':
      return wrap({ ...base, checkpoints: [7, first] });
    case 'checkpoint-key-missing': {
      const { key: _dropped, ...rest } = first ?? {};
      return wrap({ ...base, checkpoints: [rest] });
    }
    case 'checkpoint-score-string':
      return withFirst({ score: '55' });
    case 'checkpoint-score-nan-string':
      return withFirst({ score: 'NaN' });
    case 'checkpoint-score-huge':
      return withFirst({ score: Number.MAX_VALUE, applicable: true });
    case 'checkpoint-score-negative':
      return withFirst({ score: -1e12, applicable: true });
    case 'checkpoint-applicable-string':
      return withFirst({ applicable: 'true' });
    case 'shottype-number':
      return wrap({ ...base, shotType: 3 });
    case 'shottype-null':
      return wrap({ ...base, shotType: null });
    case 'shottype-object':
      return wrap({ ...base, shotType: { slug: 'dink' } });
    case 'shottype-missing': {
      const { shotType: _dropped, ...rest } = base;
      return wrap(rest);
    }
    case 'capturedat-number':
      return wrap({ ...base, capturedAtIso: 1_756_000_000_000 });
    case 'capturedat-null':
      return wrap({ ...base, capturedAtIso: null });
    case 'capturedat-object':
      return wrap({ ...base, capturedAtIso: { iso: base.capturedAtIso } });
    case 'capturedat-missing': {
      const { capturedAtIso: _dropped, ...rest } = base;
      return wrap(rest);
    }
    case 'id-number':
      return wrap({ ...base, id: 12345 });
    case 'id-null':
      return wrap({ ...base, id: null });
    case 'id-missing': {
      const { id: _dropped, ...rest } = base;
      return wrap(rest);
    }
  }
}

// ─── Independent reference ───────────────────────────────────────────────────

/** Well-typed fact check — every field the module's type promises. */
export function isWellTypedFact(fact: unknown): fact is ScoredCheckpointFact {
  if (typeof fact !== 'object' || fact === null) return false;
  const f = fact as Record<string, unknown>;
  if (typeof f.id !== 'string') return false;
  if (typeof f.shotType !== 'string') return false;
  if (typeof f.capturedAt !== 'string') return false;
  if (!Array.isArray(f.checkpoints)) return false;
  return f.checkpoints.every(cp => {
    if (typeof cp !== 'object' || cp === null) return false;
    const c = cp as Record<string, unknown>;
    return (
      typeof c.key === 'string' &&
      (c.score === null ||
        (typeof c.score === 'number' && Number.isFinite(c.score))) &&
      typeof c.applicable === 'boolean'
    );
  });
}

/** A focus the UI can render truthfully. */
export function isRenderableFocus(focus: unknown): focus is LibraryFocus {
  if (typeof focus !== 'object' || focus === null) return false;
  const f = focus as Record<string, unknown>;
  return (
    typeof f.shotType === 'string' &&
    typeof f.checkpoint === 'string' &&
    typeof f.family === 'string' &&
    typeof f.averageScore === 'number' &&
    Number.isFinite(f.averageScore) &&
    Number.isInteger(f.averageScore) &&
    typeof f.sampleCount === 'number' &&
    Number.isInteger(f.sampleCount) &&
    f.sampleCount >= 2
  );
}

/**
 * Reference "may a focus exist at all?" from the kept payloads: true iff some
 * technique's 8 most recent kept reads carry ≥2 observations (applicable
 * === true, finite numeric score) of one checkpoint. A `false` here with a
 * non-null focus from the module is fake success.
 */
export function referenceFocusPossible(
  payloads: readonly PayloadShape[],
): boolean {
  const byShot = new Map<string, PayloadShape[]>();
  const ordered = [...payloads].sort((a, b) => {
    const ca = String(a.capturedAtIso);
    const cb = String(b.capturedAtIso);
    if (ca !== cb) return ca < cb ? 1 : -1;
    const ia = String(a.id);
    const ib = String(b.id);
    return ia === ib ? 0 : ia < ib ? 1 : -1;
  });
  for (const p of ordered) {
    const list = byShot.get(String(p.shotType)) ?? [];
    if (list.length < 8) {
      list.push(p);
      byShot.set(String(p.shotType), list);
    }
  }
  for (const list of byShot.values()) {
    const counts = new Map<string, number>();
    for (const p of list) {
      for (const cp of p.checkpoints as unknown[]) {
        if (typeof cp !== 'object' || cp === null) continue;
        const c = cp as Record<string, unknown>;
        if (c.applicable !== true) continue;
        if (typeof c.score !== 'number' || !Number.isFinite(c.score)) continue;
        counts.set(String(c.key), (counts.get(String(c.key)) ?? 0) + 1);
      }
    }
    for (const n of counts.values()) if (n >= 2) return true;
  }
  return false;
}

/** Facts for the screen-level campaign: two dink reads whose weakest
 * checkpoint is contact_position (recency-weighted (2·50 + 1·60)/3 ≈ 53). */
export function dinkFocusFacts(): ScoredCheckpointFact[] {
  return [
    {
      id: '00000000-0000-4000-8000-000000000002',
      shotType: 'dink',
      capturedAt: '2026-08-02T10:00:00.000Z',
      checkpoints: [
        { key: 'contact_position', score: 50, applicable: true },
        { key: 'athletic_base', score: 80, applicable: true },
      ],
    },
    {
      id: '00000000-0000-4000-8000-000000000001',
      shotType: 'dink',
      capturedAt: '2026-08-01T10:00:00.000Z',
      checkpoints: [
        { key: 'contact_position', score: 60, applicable: true },
        { key: 'athletic_base', score: 82, applicable: true },
      ],
    },
  ];
}

// ─── Report writer ───────────────────────────────────────────────────────────

export const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(__dirname, '../../../../artifacts/stress/mod-library-focus');

export interface CampaignReport {
  campaign: string;
  lens: 'failure-injection';
  unit: 'mod-library-focus';
  plane: string;
  node: string;
  generatedAt: string;
  replay: string;
  totals: {
    scenarios: number;
    held: number;
    broken: number;
    byDependency: Record<string, number>;
    byFault: Record<string, number>;
    byDefect: Record<string, number>;
  };
  rows: ScenarioRow[];
}

export function writeCampaignReport(
  campaign: string,
  plane: string,
  replay: string,
  rows: readonly ScenarioRow[],
): string {
  const count = (key: (row: ScenarioRow) => string | null) => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const k = key(row);
      if (k === null) continue;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const report: CampaignReport = {
    campaign,
    lens: 'failure-injection',
    unit: 'mod-library-focus',
    plane,
    node: process.version,
    generatedAt: new Date().toISOString(),
    replay,
    totals: {
      scenarios: rows.length,
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      byDependency: count(r => r.dependency),
      byFault: count(r => r.fault),
      byDefect: count(r => r.defect),
    },
    rows: [...rows],
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${campaign}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
