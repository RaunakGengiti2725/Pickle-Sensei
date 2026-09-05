import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type {
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../../src/review/formReviewModel';

/**
 * Shared generator for the `mod-review-models` boundary/malformed-input
 * stress campaigns (`__tests__/stress/*.boundaryMalformed.test.ts`).
 *
 * Every campaign iteration derives from ONE 32-bit seed through
 * `mulberry32`, so any recorded outcome replays exactly with
 *   STRESS_SEED=<seed> STRESS_ITER=1 npx jest __tests__/stress/<file>
 * The generators here produce the lens vocabulary — malformed / truncated
 * JSON, wrong types, prototype-chain keys, NaN/±Infinity/-0/overflow, null
 * bytes, ≥64 KB strings (ASCII vs multi-byte vs multi-codepoint graphemes),
 * path traversal in ids, future schema versions, empty arrays/objects and
 * Unicode normalization pairs — as mutations of otherwise valid records.
 *
 * Nothing here touches production code; the harness only observes.
 */

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

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

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() on an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }
}

// ─── Campaign configuration ─────────────────────────────────────────────────

declare const process: { env: Record<string, string | undefined> };

/** Iterations per campaign: `STRESS_ITER` (default small so the suite stays
 * fast); `STRESS_SEED` pins a single seed for replay. `seedAt(i, salt)`
 * derives the seed for iteration `i` of a campaign; the recorded seed is
 * exactly what `STRESS_SEED=<seed>` feeds back in, whatever the salt. */
export function campaignPlan(defaultIterations: number): {
  iterations: number;
  seedAt: (index: number, salt?: number) => number;
} {
  const pinned = process.env.STRESS_SEED;
  if (pinned !== undefined && pinned !== '') {
    const seed = Number(pinned) >>> 0;
    return { iterations: 1, seedAt: () => seed };
  }
  const raw = process.env.STRESS_ITER;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  const iterations =
    Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultIterations;
  return {
    iterations,
    seedAt: (index, salt = 0) => ((0x9e3779b9 * (index + 1)) ^ salt) >>> 0,
  };
}

// ─── Result table ───────────────────────────────────────────────────────────

export interface CaseRecord {
  campaign: string;
  seed: number;
  outcome: 'held' | 'broken';
  /** Short generator summary (which mutations were applied). */
  mutations: string[];
  /** Invariant that failed, or the thrown error, when broken. */
  detail: string | null;
}

export class ResultTable {
  readonly records: CaseRecord[] = [];

  constructor(readonly suite: string) {}

  record(entry: CaseRecord): void {
    this.records.push(entry);
  }

  get broken(): CaseRecord[] {
    return this.records.filter(r => r.outcome === 'broken');
  }

  /** View over the records appended since `from` (one campaign's slice). */
  since(from: number): ResultTable {
    const view = new ResultTable(this.suite);
    for (const record of this.records.slice(from)) view.record(record);
    return view;
  }

  /** Writes the seed → outcome table beside the other verify artifacts
   * (`artifacts/stress/…`, gitignored) or under `STRESS_OUT`. */
  flush(): string {
    const { mkdirSync, writeFileSync } = nodeRequire('fs') as {
      mkdirSync: (path: string, options: { recursive: boolean }) => void;
      writeFileSync: (path: string, data: string) => void;
    };
    const { join } = nodeRequire('path') as {
      join: (...parts: string[]) => string;
    };
    const dir =
      process.env.STRESS_OUT ??
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'artifacts',
        'stress',
        'mod-review-models-boundary-malformed',
      );
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.suite}.json`);
    const broken = this.broken;
    writeFileSync(
      path,
      JSON.stringify(
        {
          suite: this.suite,
          lens: 'boundary-malformed',
          generatedAt: new Date().toISOString(),
          iterations: this.records.length,
          held: this.records.length - broken.length,
          broken: broken.length,
          brokenSeeds: broken.map(r => `${r.campaign}:${r.seed}`),
          records: this.records,
        },
        null,
        1,
      ),
    );
    return path;
  }
}

// The mobile tsconfig excludes node typings (see networkAuthAdversarial):
// resolve fs/path through a locally declared require.
declare const require: (id: string) => unknown;
declare const __dirname: string;
const nodeRequire = require;

/** Runs `body` for one seed and records held/broken. Throws from `body`
 * are recorded as broken — the invariant under test is "never throws". */
export function runCase(
  table: ResultTable,
  campaign: string,
  seed: number,
  body: (rng: Rng, mutations: string[]) => void,
): void {
  const rng = new Rng(seed);
  const mutations: string[] = [];
  try {
    body(rng, mutations);
    table.record({ campaign, seed, outcome: 'held', mutations, detail: null });
  } catch (error) {
    table.record({
      campaign,
      seed,
      outcome: 'broken',
      mutations,
      detail: describeError(error),
    });
  }
}

export async function runCaseAsync(
  table: ResultTable,
  campaign: string,
  seed: number,
  body: (rng: Rng, mutations: string[]) => Promise<void>,
): Promise<void> {
  const rng = new Rng(seed);
  const mutations: string[] = [];
  try {
    await body(rng, mutations);
    table.record({ campaign, seed, outcome: 'held', mutations, detail: null });
  } catch (error) {
    table.record({
      campaign,
      seed,
      outcome: 'broken',
      mutations,
      detail: describeError(error),
    });
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `thrown non-Error: ${safeString(error)}`;
}

/** Summarizes broken records for an assertion message. */
export function brokenSummary(table: ResultTable): string {
  const broken = table.broken;
  const shown = broken
    .slice(0, 12)
    .map(
      r =>
        `  ${r.campaign} seed=${r.seed} [${r.mutations.join(', ')}] → ${r.detail}`,
    );
  return (
    `${broken.length} broken of ${table.records.length}` +
    (broken.length > 0 ? `:\n${shown.join('\n')}` : '') +
    (broken.length > shown.length
      ? `\n  … +${broken.length - shown.length}`
      : '')
  );
}

/** Invariant helper: throws a labelled error when `condition` is false. */
export function invariant(condition: boolean, label: string): void {
  if (!condition) throw new Error(`invariant: ${label}`);
}

export function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return JSON.stringify(value.slice(0, 80));
    if (typeof value === 'function') return `[function ${value.name}]`;
    if (typeof value === 'object' && value !== null) {
      const json = JSON.stringify(value);
      return json === undefined ? '[object]' : json.slice(0, 120);
    }
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

// ─── Lens vocabulary ────────────────────────────────────────────────────────

/** Keys that resolve through Object.prototype on a plain-object lookup table. */
export const PROTO_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__lookupGetter__',
] as const;

export const TRAVERSAL_STRINGS = [
  '../../etc/passwd',
  '..\\..\\Windows\\win.ini',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  'file:///../../private/var/mobile',
  'file:///captures/../../Library/Preferences/x.json',
  '/etc/passwd',
  '....//....//',
  'file://\u0000/captures/clip.pose.json',
  'contact_position/../paddle_path',
] as const;

/** Canonically-equivalent pairs (NFC, NFD/compat) that compare unequal. */
export const UNICODE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u00e9', 'e\u0301'],
  ['\uFB01', 'fi'],
  ['\u212B', '\u00C5'],
  ['\uD55C', '\u1112\u1161\u11AB'],
  ['contact_position', 'contact\uFF3Fposition'],
  ['dink', 'd\u0131nk'],
];

export const NULL_BYTE_STRINGS = [
  '\0',
  'a\0b',
  'contact_position\0',
  '\0\0\0',
  'dink\u0000../x',
] as const;

const KIB = 1024;

/** ≥64 KiB strings that differ in byte vs codepoint vs grapheme counts. */
export function bigString(kind: number): string {
  switch (kind % 5) {
    case 0:
      return 'a'.repeat(64 * KIB);
    case 1:
      return 'b'.repeat(64 * KIB + 1);
    case 2:
      // 2-byte codepoints: 64 KiB of codepoints = 128 KiB UTF-8.
      return '\u00e9'.repeat(64 * KIB);
    case 3:
      // Multi-codepoint graphemes (ZWJ family): 7 codepoints, 25 bytes each.
      return '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(
        10 * KIB,
      );
    default:
      // Unpaired surrogate every 4 chars — invalid UTF-16 sequences.
      return 'ab\uD800c'.repeat(16 * KIB);
  }
}

export function weirdNumber(rng: Rng): number {
  return rng.pick<number>([
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    1e308,
    -1e308,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 2,
    2 ** 53,
    1e21,
    -1,
    100,
    101,
    100.0000001,
    -100,
    0.5,
    1 / 3,
    rng.float() * 2e6 - 1e6,
    rng.float(),
    rng.int(-5, 105),
  ]);
}

export function weirdString(rng: Rng): string {
  const roll = rng.int(0, 9);
  switch (roll) {
    case 0:
      return rng.pick(PROTO_KEYS);
    case 1:
      return rng.pick(TRAVERSAL_STRINGS);
    case 2: {
      const pair = rng.pick(UNICODE_PAIRS);
      return rng.chance(0.5) ? pair[0] : pair[1];
    }
    case 3:
      return rng.pick(NULL_BYTE_STRINGS);
    case 4:
      return bigString(rng.int(0, 4));
    case 5:
      return '';
    case 6:
      return ' ';
    case 7:
      return rng.pick(['NaN', 'Infinity', '-0', '1e999', '0x10', '1n', '[]']);
    case 8:
      return rng.pick(['{"__proto__":{"polluted":1}}', '<script>', '\u202e']);
    default:
      return `s${rng.int(0, 1e9).toString(36)}`;
  }
}

export function weirdPrimitive(rng: Rng): unknown {
  switch (rng.int(0, 5)) {
    case 0:
      return weirdNumber(rng);
    case 1:
      return weirdString(rng);
    case 2:
      return rng.chance(0.5);
    case 3:
      return null;
    case 4:
      return undefined;
    default:
      return weirdNumber(rng);
  }
}

/** Object with an OWN `__proto__` key (as JSON.parse creates it) plus a
 * `constructor.prototype` payload — the classic pollution vectors. */
export function pollutionCarrier(rng: Rng): Record<string, unknown> {
  const marker = `polluted_${rng.int(0, 1e9)}`;
  return JSON.parse(
    `{"__proto__":{"${marker}":1},"constructor":{"prototype":{"${marker}":2}}}`,
  ) as Record<string, unknown>;
}

export function weirdValue(rng: Rng, depth = 0): unknown {
  if (depth > 2) return weirdPrimitive(rng);
  switch (rng.int(0, 7)) {
    case 0:
      return [];
    case 1:
      return {};
    case 2:
      return pollutionCarrier(rng);
    case 3: {
      const out: unknown[] = [];
      const n = rng.int(1, 4);
      for (let i = 0; i < n; i += 1) out.push(weirdValue(rng, depth + 1));
      return out;
    }
    case 4: {
      const out: Record<string, unknown> = {};
      const n = rng.int(1, 4);
      for (let i = 0; i < n; i += 1) {
        out[weirdString(rng)] = weirdValue(rng, depth + 1);
      }
      return out;
    }
    default:
      return weirdPrimitive(rng);
  }
}

/** Snapshot of Object.prototype / Array.prototype own keys, to prove no
 * iteration polluted a shared prototype. */
export function prototypeFingerprint(): string {
  return JSON.stringify([
    Object.getOwnPropertyNames(Object.prototype).sort(),
    Object.getOwnPropertyNames(Array.prototype).sort(),
    Object.getOwnPropertyNames(String.prototype).length,
    (Object.prototype as { polluted?: unknown }).polluted,
  ]);
}

// ─── Valid fixtures ─────────────────────────────────────────────────────────

export const ALL_CHECKPOINTS: readonly CheckpointKey[] = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
];

export const ALL_PHASES: readonly PhaseKey[] = [
  'ready',
  'prepare',
  'accelerate',
  'contact',
  'follow_through',
  'recover',
];

export const ALL_DIRECTIONS: readonly FaultDirection[] = [
  'late',
  'early',
  'high',
  'low',
  'long',
  'short',
  'wide',
  'narrow',
  'open',
  'closed',
  'unstable',
  'none',
];

export const ALL_BANDS: readonly ScoreBand[] = [
  'green',
  'yellow',
  'red',
  'unscored',
];

export const ALL_SHOT_TYPES: readonly ShotAnalysis['shotType'][] = [
  'serve',
  'return',
  'forehand_drive',
  'backhand_drive',
  'third_shot_drop',
  'dink',
  'volley',
  'overhead',
];

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

/** A well-formed scored analysis (same shape the engine persists). */
export function validAnalysis(rng: Rng): ShotAnalysis {
  const checkpoints: CheckpointScore[] = ALL_CHECKPOINTS.map(key => {
    const score = rng.int(20, 100);
    const band: ScoreBand =
      score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red';
    return {
      key,
      score,
      confidence: 0.8,
      band,
      direction: band === 'green' ? 'none' : rng.pick(ALL_DIRECTIONS),
      severity: (100 - score) / 100,
      applicable: rng.chance(0.9),
    };
  });
  return {
    id: `analysis-${rng.int(0, 1e9)}`,
    sessionId: null,
    shotType: rng.pick(ALL_SHOT_TYPES),
    cameraView: 'side',
    handedness: rng.pick(['right', 'left', 'ambidextrous']),
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [
      phase('ready', 0, 900),
      phase('prepare', 900, 1500),
      phase('accelerate', 1500, 1900),
      phase('contact', 1880, 1920, 1900),
      phase('follow_through', 1920, 2400),
      phase('recover', 2400, 3200),
    ],
    measurements: [],
    checkpoints,
    overallScore: 7.1,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: rng.pick(ALL_CHECKPOINTS),
      reasonKey: 'lowest_score',
      severity: 0.5,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '1.0.0',
      modelBundleVersion: 'bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
  };
}

export const REVIEW_LANDMARKS = [
  'head',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

/** A well-formed 30 fps swing: monotonic timestamps, 13 visible joints. */
export function validSequence(
  rng: Rng,
  frameCount = 60,
): ReviewPoseSequence & {
  video: { width: number; height: number; fps: number };
} {
  const frames: ReviewPoseFrame[] = [];
  const phaseOffset = rng.float() * Math.PI;
  for (let i = 0; i < frameCount; i += 1) {
    const t = i / 30;
    frames.push({
      timestampMs: Math.round(i * (1000 / 30)),
      confidence: 0.9,
      landmarks: REVIEW_LANDMARKS.map((name, index) => ({
        name,
        x: 0.5 + 0.1 * Math.sin(t * 2 + index + phaseOffset),
        y: 0.2 + index * 0.05 + 0.02 * Math.cos(t * 3 + index),
        visibility: 0.95,
      })),
    });
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

// ─── Mutation catalogs ──────────────────────────────────────────────────────

type Mutable = Record<string, unknown>;

function asMutable(value: unknown): Mutable {
  return value as Mutable;
}

function pickIndex(rng: Rng, list: unknown[]): number {
  return list.length === 0 ? -1 : rng.int(0, list.length - 1);
}

/** Applies `count` random mutations from the analysis catalog. Returns the
 * mutated record (typed loosely — that is the point) and its mutation log. */
export function mutateAnalysis(
  rng: Rng,
  analysis: ShotAnalysis,
  count: number,
  log: string[],
): ShotAnalysis {
  const record = asMutable(analysis);
  for (let step = 0; step < count; step += 1) {
    const mutation = rng.pick(ANALYSIS_MUTATIONS);
    mutation.apply(rng, record);
    log.push(mutation.name);
  }
  return record as unknown as ShotAnalysis;
}

function checkpointsOf(record: Mutable): Mutable[] | null {
  return Array.isArray(record.checkpoints)
    ? (record.checkpoints as Mutable[])
    : null;
}

function phasesOf(record: Mutable): Mutable[] | null {
  return Array.isArray(record.phases) ? (record.phases as Mutable[]) : null;
}

interface Mutation {
  name: string;
  apply(rng: Rng, record: Mutable): void;
}

function onCheckpoint(
  name: string,
  edit: (rng: Rng, cp: Mutable) => void,
): Mutation {
  return {
    name,
    apply(rng, record) {
      const list = checkpointsOf(record);
      if (!list) return;
      const index = pickIndex(rng, list);
      const cp = list[index];
      if (cp && typeof cp === 'object') edit(rng, cp);
    },
  };
}

function onPhase(
  name: string,
  edit: (rng: Rng, span: Mutable) => void,
): Mutation {
  return {
    name,
    apply(rng, record) {
      const list = phasesOf(record);
      if (!list) return;
      const index = pickIndex(rng, list);
      const span = list[index];
      if (span && typeof span === 'object') edit(rng, span);
    },
  };
}

export const ANALYSIS_MUTATIONS: readonly Mutation[] = [
  onCheckpoint('cp.key=proto', (rng, cp) => {
    cp.key = rng.pick(PROTO_KEYS);
  }),
  onCheckpoint('cp.key=weirdString', (rng, cp) => {
    cp.key = weirdString(rng);
  }),
  onCheckpoint('cp.key=weirdValue', (rng, cp) => {
    cp.key = weirdValue(rng);
  }),
  onCheckpoint('cp.direction=proto', (rng, cp) => {
    cp.direction = rng.pick(PROTO_KEYS);
  }),
  onCheckpoint('cp.direction=weird', (rng, cp) => {
    cp.direction = weirdValue(rng);
  }),
  onCheckpoint('cp.band=proto', (rng, cp) => {
    cp.band = rng.pick(PROTO_KEYS);
  }),
  onCheckpoint('cp.band=weird', (rng, cp) => {
    cp.band = weirdValue(rng);
  }),
  onCheckpoint('cp.band=red', (_rng, cp) => {
    cp.band = 'red';
  }),
  onCheckpoint('cp.score=weirdNumber', (rng, cp) => {
    cp.score = weirdNumber(rng);
  }),
  onCheckpoint('cp.score=weirdValue', (rng, cp) => {
    cp.score = weirdValue(rng);
  }),
  onCheckpoint('cp.severity=weird', (rng, cp) => {
    cp.severity = weirdValue(rng);
  }),
  onCheckpoint('cp.applicable=weird', (rng, cp) => {
    cp.applicable = weirdValue(rng);
  }),
  onCheckpoint('cp.confidence=weird', (rng, cp) => {
    cp.confidence = weirdNumber(rng);
  }),
  {
    name: 'cp.entry=weirdValue',
    apply(rng, record) {
      const list = checkpointsOf(record);
      if (!list) return;
      const index = pickIndex(rng, list);
      if (index >= 0) list[index] = weirdValue(rng) as Mutable;
    },
  },
  {
    name: 'cp.duplicate',
    apply(rng, record) {
      const list = checkpointsOf(record);
      if (!list || list.length === 0) return;
      const source = list[pickIndex(rng, list)];
      list.splice(
        rng.int(0, list.length),
        0,
        source && typeof source === 'object' ? { ...source } : source!,
      );
    },
  },
  {
    name: 'checkpoints=[]',
    apply(_rng, record) {
      record.checkpoints = [];
    },
  },
  {
    name: 'checkpoints=weirdValue',
    apply(rng, record) {
      record.checkpoints = weirdValue(rng);
    },
  },
  {
    name: 'checkpoints=huge',
    apply(rng, record) {
      const list = checkpointsOf(record) ?? [];
      const out: unknown[] = [];
      for (let i = 0; i < 1000; i += 1) {
        const source = list[i % Math.max(1, list.length)];
        out.push(
          source && typeof source === 'object'
            ? { ...source, score: rng.int(0, 100) }
            : weirdValue(rng),
        );
      }
      record.checkpoints = out;
    },
  },
  onPhase('phase.key=proto', (rng, span) => {
    span.key = rng.pick(PROTO_KEYS);
  }),
  onPhase('phase.key=weird', (rng, span) => {
    span.key = weirdValue(rng);
  }),
  onPhase('phase.startMs=weird', (rng, span) => {
    span.startMs = weirdNumber(rng);
  }),
  onPhase('phase.endMs=weird', (rng, span) => {
    span.endMs = weirdNumber(rng);
  }),
  onPhase('phase.representativeMs=weird', (rng, span) => {
    span.representativeMs = weirdValue(rng);
  }),
  onPhase('phase.reversed', (_rng, span) => {
    const start = span.startMs;
    span.startMs = span.endMs;
    span.endMs = start;
  }),
  {
    name: 'phase.entry=weirdValue',
    apply(rng, record) {
      const list = phasesOf(record);
      if (!list) return;
      const index = pickIndex(rng, list);
      if (index >= 0) list[index] = weirdValue(rng) as Mutable;
    },
  },
  {
    name: 'phase.duplicate',
    apply(rng, record) {
      const list = phasesOf(record);
      if (!list || list.length === 0) return;
      const source = list[pickIndex(rng, list)];
      list.push(source && typeof source === 'object' ? { ...source } : source!);
    },
  },
  {
    name: 'phases=[]',
    apply(_rng, record) {
      record.phases = [];
    },
  },
  {
    name: 'phases=weirdValue',
    apply(rng, record) {
      record.phases = weirdValue(rng);
    },
  },
  {
    name: 'timestamps=weirdValue',
    apply(rng, record) {
      record.timestamps = weirdValue(rng);
    },
  },
  {
    name: 'timestamps.field=weirdNumber',
    apply(rng, record) {
      const timestamps = record.timestamps;
      if (!timestamps || typeof timestamps !== 'object') return;
      asMutable(timestamps)[rng.pick(['startMs', 'contactMs', 'endMs'])] =
        weirdNumber(rng);
    },
  },
  {
    name: 'shotType=proto',
    apply(rng, record) {
      record.shotType = rng.pick(PROTO_KEYS);
    },
  },
  {
    name: 'shotType=weird',
    apply(rng, record) {
      record.shotType = weirdValue(rng);
    },
  },
  {
    name: 'handedness=weird',
    apply(rng, record) {
      record.handedness = weirdValue(rng);
    },
  },
  {
    name: 'priorityFix=weirdValue',
    apply(rng, record) {
      record.priorityFix = weirdValue(rng);
    },
  },
  {
    name: 'priorityFix.checkpoint=proto',
    apply(rng, record) {
      const fix = record.priorityFix;
      if (!fix || typeof fix !== 'object') return;
      asMutable(fix).checkpoint = rng.pick(PROTO_KEYS);
    },
  },
  {
    name: 'priorityFix.checkpoint=firstCpKey',
    apply(_rng, record) {
      const fix = record.priorityFix;
      const list = checkpointsOf(record);
      const first = list?.[0];
      if (
        !fix ||
        typeof fix !== 'object' ||
        !first ||
        typeof first !== 'object'
      )
        return;
      asMutable(fix).checkpoint = first.key;
    },
  },
  {
    name: 'root.__proto__own',
    apply(rng, record) {
      Object.assign(record, pollutionCarrier(rng));
    },
  },
  {
    name: 'root.schemaVersion=future',
    apply(rng, record) {
      record.schemaVersion = rng.pick([2, 99, '1', 1.5, Infinity]);
      record.version = 99;
    },
  },
  {
    name: 'id=traversal',
    apply(rng, record) {
      record.id = rng.pick(TRAVERSAL_STRINGS);
    },
  },
  {
    name: 'id=bigString',
    apply(rng, record) {
      record.id = bigString(rng.int(0, 4));
    },
  },
  {
    name: 'overallScore=weird',
    apply(rng, record) {
      record.overallScore = weirdValue(rng);
    },
  },
  {
    name: 'resultKind=weird',
    apply(rng, record) {
      record.resultKind = weirdValue(rng);
    },
  },
  {
    name: 'measurements=weird',
    apply(rng, record) {
      record.measurements = weirdValue(rng);
    },
  },
  {
    name: 'versionVector=weird',
    apply(rng, record) {
      record.versionVector = weirdValue(rng);
    },
  },
];

/** Persisted-row realism: JSON round trip (NaN/±Infinity → null, undefined
 * dropped, own `__proto__` becomes a plain own key). */
export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Type-PRESERVING sequence mutations (numbers stay numbers, strings stay
 * strings, arrays stay arrays): what a strict-parsed sidecar can still
 * carry — pathological but well-typed values. */
export function mutateSequenceTyped(
  rng: Rng,
  sequence: ReviewPoseSequence,
  count: number,
  log: string[],
): ReviewPoseSequence {
  const record = asMutable(sequence);
  for (let step = 0; step < count; step += 1) {
    const mutation = rng.pick(SEQUENCE_TYPED_MUTATIONS);
    mutation.apply(rng, record);
    log.push(mutation.name);
  }
  return record as unknown as ReviewPoseSequence;
}

function framesOf(record: Mutable): Mutable[] | null {
  return Array.isArray(record.frames) ? (record.frames as Mutable[]) : null;
}

function onFrame(
  name: string,
  edit: (rng: Rng, frame: Mutable) => void,
): Mutation {
  return {
    name,
    apply(rng, record) {
      const frames = framesOf(record);
      if (!frames || frames.length === 0) return;
      const frame = frames[pickIndex(rng, frames)];
      if (frame && typeof frame === 'object') edit(rng, frame);
    },
  };
}

function onLandmark(
  name: string,
  edit: (rng: Rng, mark: Mutable) => void,
): Mutation {
  return onFrame(name, (rng, frame) => {
    const marks = Array.isArray(frame.landmarks)
      ? (frame.landmarks as Mutable[])
      : null;
    if (!marks || marks.length === 0) return;
    const mark = marks[pickIndex(rng, marks)];
    if (mark && typeof mark === 'object') edit(rng, mark);
  });
}

export const SEQUENCE_TYPED_MUTATIONS: readonly Mutation[] = [
  onFrame('frame.timestampMs=weirdNumber', (rng, frame) => {
    frame.timestampMs = weirdNumber(rng);
  }),
  onFrame('frame.confidence=weirdNumber', (rng, frame) => {
    frame.confidence = weirdNumber(rng);
  }),
  onFrame('frame.landmarks=[]', (_rng, frame) => {
    frame.landmarks = [];
  }),
  onLandmark('mark.x=weirdNumber', (rng, mark) => {
    mark.x = weirdNumber(rng);
  }),
  onLandmark('mark.y=weirdNumber', (rng, mark) => {
    mark.y = weirdNumber(rng);
  }),
  onLandmark('mark.visibility=weirdNumber', (rng, mark) => {
    mark.visibility = weirdNumber(rng);
  }),
  onLandmark('mark.name=proto', (rng, mark) => {
    mark.name = rng.pick(PROTO_KEYS);
  }),
  onLandmark('mark.name=weirdString', (rng, mark) => {
    mark.name = weirdString(rng);
  }),
  onLandmark('mark.name=unicodePair', (rng, mark) => {
    mark.name = rng.pick(UNICODE_PAIRS)[1];
  }),
  {
    name: 'frames.allWristsWeird',
    apply(rng, record) {
      const frames = framesOf(record);
      if (!frames) return;
      const value = weirdNumber(rng);
      for (const frame of frames) {
        const marks = Array.isArray(frame.landmarks)
          ? (frame.landmarks as Mutable[])
          : [];
        for (const mark of marks) {
          if (mark.name === 'left_wrist' || mark.name === 'right_wrist') {
            mark.x = value;
          }
        }
      }
    },
  },
  {
    name: 'frames.swapTwo',
    apply(rng, record) {
      const frames = framesOf(record);
      if (!frames || frames.length < 2) return;
      const a = pickIndex(rng, frames);
      const b = pickIndex(rng, frames);
      const tmp = frames[a]!;
      frames[a] = frames[b]!;
      frames[b] = tmp;
    },
  },
  {
    name: 'frames.duplicateOne',
    apply(rng, record) {
      const frames = framesOf(record);
      if (!frames || frames.length === 0) return;
      const source = frames[pickIndex(rng, frames)]!;
      frames.splice(rng.int(0, frames.length), 0, { ...source });
    },
  },
  {
    name: 'frames=[]',
    apply(_rng, record) {
      record.frames = [];
    },
  },
  {
    name: 'frames.single',
    apply(_rng, record) {
      const frames = framesOf(record);
      if (frames && frames.length > 0) record.frames = [frames[0]];
    },
  },
  {
    name: 'video.dim=weirdNumber',
    apply(rng, record) {
      const video = record.video;
      if (!video || typeof video !== 'object') return;
      asMutable(video)[rng.pick(['width', 'height', 'fps'])] = weirdNumber(rng);
    },
  },
  {
    name: 'video=wireShape',
    apply(rng, record) {
      record.video = { w: weirdNumber(rng), h: rng.int(1, 4000), fps: 30 };
    },
  },
  {
    name: 'video=undefined',
    apply(_rng, record) {
      delete record.video;
    },
  },
];

// ─── Sidecar (wire JSON) mutations ──────────────────────────────────────────

export interface WireLandmark {
  n: string;
  x: number;
  y: number;
  v: number;
  z?: number;
}
export interface WireFrame {
  i: number;
  t: number;
  c: number;
  l: WireLandmark[];
}
export interface WireSequence {
  schemaVersion: number;
  format: string;
  coordinateSystem: string;
  poseModelVersion: string;
  video: { w: number; h: number; fps: number };
  frames: WireFrame[];
}

export function validWire(rng: Rng, frameCount = 40): WireSequence {
  const sequence = validSequence(rng, frameCount);
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
    video: { w: 1080, h: 1920, fps: 30 },
    frames: sequence.frames.map((frame, index) => ({
      i: index,
      t: frame.timestampMs,
      c: frame.confidence,
      l: frame.landmarks.map(mark => ({
        n: mark.name,
        x: mark.x,
        y: mark.y,
        v: mark.visibility,
      })),
    })),
  };
}

function onWireFrame(
  name: string,
  edit: (rng: Rng, frame: Mutable) => void,
): Mutation {
  return {
    name,
    apply(rng, record) {
      const frames = framesOf(record);
      if (!frames || frames.length === 0) return;
      const frame = frames[pickIndex(rng, frames)];
      if (frame && typeof frame === 'object') edit(rng, frame);
    },
  };
}

function onWireLandmark(
  name: string,
  edit: (rng: Rng, mark: Mutable) => void,
): Mutation {
  return onWireFrame(name, (rng, frame) => {
    const marks = Array.isArray(frame.l) ? (frame.l as Mutable[]) : null;
    if (!marks || marks.length === 0) return;
    const mark = marks[pickIndex(rng, marks)];
    if (mark && typeof mark === 'object') edit(rng, mark);
  });
}

export const WIRE_MUTATIONS: readonly Mutation[] = [
  {
    name: 'schemaVersion=future',
    apply(rng, record) {
      record.schemaVersion = rng.pick([2, 3, 99, 1.0000001, '1', -1, 1e308]);
    },
  },
  {
    name: 'format=variant',
    apply(rng, record) {
      record.format = rng.pick([
        'pickle.pose-sequence.v2',
        'PICKLE.POSE-SEQUENCE.V1',
        'pickle.pose-sequence.v1 ',
        'pickle.pose-sequence.v1\0',
        weirdString(rng),
      ]);
    },
  },
  {
    name: 'coordinateSystem=unknown',
    apply(rng, record) {
      record.coordinateSystem = rng.pick([
        'image_pixels',
        'normalized_image_bottom_left',
        'NORMALIZED_IMAGE_TOP_LEFT',
        weirdString(rng),
      ]);
    },
  },
  {
    name: 'poseModelVersion=weird',
    apply(rng, record) {
      record.poseModelVersion = weirdValue(rng);
    },
  },
  {
    name: 'poseModelVersion=bigString',
    apply(rng, record) {
      record.poseModelVersion = bigString(rng.int(0, 4));
    },
  },
  {
    name: 'video=weird',
    apply(rng, record) {
      record.video = weirdValue(rng);
    },
  },
  {
    name: 'video.field=weirdNumber',
    apply(rng, record) {
      const video = record.video;
      if (!video || typeof video !== 'object') return;
      asMutable(video)[rng.pick(['w', 'h', 'fps'])] = weirdNumber(rng);
    },
  },
  {
    name: 'frames=weird',
    apply(rng, record) {
      record.frames = weirdValue(rng);
    },
  },
  {
    name: 'frames=[]',
    apply(_rng, record) {
      record.frames = [];
    },
  },
  {
    name: 'frames.entry=weird',
    apply(rng, record) {
      const frames = framesOf(record);
      if (!frames) return;
      const index = pickIndex(rng, frames);
      if (index >= 0) frames[index] = weirdValue(rng) as Mutable;
    },
  },
  {
    name: 'frames.nonMonotonic',
    apply(rng, record) {
      const frames = framesOf(record);
      if (!frames || frames.length < 2) return;
      const index = rng.int(1, frames.length - 1);
      const frame = frames[index];
      const previous = frames[index - 1];
      if (frame && previous && typeof frame === 'object') {
        frame.t = rng.chance(0.5) ? previous.t : (previous.t as number) - 1;
      }
    },
  },
  onWireFrame('frame.i=weird', (rng, frame) => {
    frame.i = rng.pick<unknown>([
      1.5,
      -1,
      NaN,
      1e300,
      '3',
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ]);
  }),
  onWireFrame('frame.t=weirdNumber', (rng, frame) => {
    frame.t = weirdNumber(rng);
  }),
  onWireFrame('frame.c=weird', (rng, frame) => {
    frame.c = weirdValue(rng);
  }),
  onWireFrame('frame.l=[]', (_rng, frame) => {
    frame.l = [];
  }),
  onWireFrame('frame.l=weird', (rng, frame) => {
    frame.l = weirdValue(rng);
  }),
  onWireFrame('frame.extraKeys', (rng, frame) => {
    Object.assign(frame, pollutionCarrier(rng));
  }),
  onWireLandmark('mark.n=weird', (rng, mark) => {
    mark.n = weirdValue(rng);
  }),
  onWireLandmark('mark.n=proto', (rng, mark) => {
    mark.n = rng.pick(PROTO_KEYS);
  }),
  onWireLandmark('mark.x=weirdNumber', (rng, mark) => {
    mark.x = weirdNumber(rng);
  }),
  onWireLandmark('mark.y=weird', (rng, mark) => {
    mark.y = weirdValue(rng);
  }),
  onWireLandmark('mark.v=weird', (rng, mark) => {
    mark.v = weirdValue(rng);
  }),
  onWireLandmark('mark.z=weird', (rng, mark) => {
    mark.z = rng.pick<unknown>([NaN, Infinity, '1', null, 0.5]);
  }),
  {
    name: 'root.__proto__own',
    apply(rng, record) {
      Object.assign(record, pollutionCarrier(rng));
    },
  },
  {
    name: 'root.unknownKeys',
    apply(rng, record) {
      record[weirdString(rng)] = weirdValue(rng);
    },
  },
];

/** JSON text-level corruption applied after serialization. */
export function corruptJsonText(rng: Rng, json: string, log: string[]): string {
  switch (rng.int(0, 9)) {
    case 0: {
      log.push('text.truncate');
      return json.slice(0, rng.int(0, Math.max(0, json.length - 1)));
    }
    case 1: {
      log.push('text.nullByte');
      const at = rng.int(0, json.length);
      return `${json.slice(0, at)}\0${json.slice(at)}`;
    }
    case 2: {
      log.push('text.garbageInsert');
      const at = rng.int(0, json.length);
      return `${json.slice(0, at)}${rng.pick(['}', '{', ',', 'NaN', 'undefined', '\uFFFF', '"'])}${json.slice(at)}`;
    }
    case 3:
      log.push('text.bom');
      return `\uFEFF${json}`;
    case 4:
      log.push('text.trailingGarbage');
      return `${json}${rng.pick([' {}', 'null', '\0', ']', ' // comment'])}`;
    case 5:
      log.push('text.nanLiteral');
      return json.replace(/"t":(-?[0-9.]+)/, '"t":NaN');
    case 6:
      log.push('text.infinityLiteral');
      return json.replace(/"x":(-?[0-9.e-]+)/, '"x":Infinity');
    case 7:
      log.push('text.duplicateKeys');
      return json.replace(
        '"schemaVersion":1',
        '"schemaVersion":99,"schemaVersion":1',
      );
    case 8: {
      log.push('text.deepNesting');
      const depth = rng.int(1000, 20000);
      return `${'['.repeat(depth)}${']'.repeat(depth)}`;
    }
    default:
      log.push('text.notJson');
      return rng.pick(['', ' ', 'null', '[]', '"string"', '42', 'true', '{']);
  }
}

// ─── Review prompt state ────────────────────────────────────────────────────

export function malformedReviewState(rng: Rng, log: string[]): string {
  const roll = rng.int(0, 5);
  if (roll === 0) {
    log.push('state.notJson');
    return rng.pick(['not-json', '', '[]', 'null', '"x"', '42', '{', 'NaN']);
  }
  const record: Mutable = {
    version: rng.chance(0.7) ? 1 : weirdValue(rng),
    scoredAnalyses: rng.chance(0.5) ? rng.int(0, 50) : weirdValue(rng),
    promptedCount: rng.chance(0.5) ? rng.int(0, 50) : weirdValue(rng),
    lastPromptedAtIso: rng.chance(0.5)
      ? '2026-08-30T00:00:00.000Z'
      : weirdValue(rng),
    reviewedAtIso: rng.chance(0.5) ? null : weirdValue(rng),
  };
  if (rng.chance(0.3)) {
    log.push('state.__proto__own');
    Object.assign(record, pollutionCarrier(rng));
  }
  if (rng.chance(0.2)) {
    log.push('state.futureVersion');
    record.version = rng.pick([2, 99, '1']);
  }
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch {
    json = '{}';
  }
  if (json === undefined) json = '{}';
  if (rng.chance(0.25)) return corruptJsonText(rng, json, log);
  log.push('state.object');
  return json;
}
